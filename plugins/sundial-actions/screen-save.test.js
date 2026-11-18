// S5R2 (plan 2B): a Save or Open panel steered by its "Go to the folder" field (run 245 T21). Made-up values only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { finalOf, judgedPlans } from './gate-finals.js'
import { pressDefault } from './screen-dialog.js'
import { format, savePanel } from './screen-look.js'
import { saveProof } from './screen-proof.js'
import { openerOf, openPanel, panelList, panelSteps } from './screen-save.js'
import { planAll, screenAsk, screenTools } from './screen-tools.js'

// The cmd+shift+g chain is behind experiments.screenPanelKeys since S6 (doc 30): these tests keep it on; the no-keys path is below.
const STATE = { config: { experiments: { screenAct: true, screenPanelKeys: true } }, marks: { now: [], guideTally: {} } }
const noLook = async () => null
const FIELD = { ref: 'e2', role: 'AXTextField', label: 'Save As:', value: 'Brief Kestrel.txt', frame: [420, 300, 240, 22], enabled: true, settable: true }
const SAVE = { ref: 'e1', role: 'AXButton', label: 'Save', value: '', frame: [600, 520, 60, 24], enabled: true, default: true, actions: ['AXPress'] }
const PANEL = { id: 'look-0000beef', app: 'TextEdit', window: 'Brief Kestrel.txt', dialog: true, focused: 'e2', menus: [], elements: [SAVE, FIELD] }
const steps = (plans) => plans.map((p) => [p.verb, p.verb === 'press' ? p.thing.name : String(p.command.value)])
/** A state whose last look is `look` (TextEdit's), and the reader that hands back its row. */
const seenAs = (look) => [{ ...STATE, marks: { ...STATE.marks, lastLook: { id: look.id, app: look.app } } }, async () => lookForLog(look)]
const [PANEL_STATE, panelLook] = seenAs(PANEL)

describe('save-as and go-to-folder are the panel\'s own steps', () => {
  it('a save into /tmp/gnomon-x/Outbox: cmd+shift+g, the folder over what the field held, Return, the name, Save', async () => {
    const want = [['key', 'cmd+shift+g'], ['key', 'cmd+a'], ['type', '/tmp/gnomon-x/Outbox'], ['key', 'return'], ['key', 'cmd+a'], ['type', 'Brief Kestrel.txt'], ['press', 'Save']]
    const out = await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' }] }, PANEL_STATE, panelLook)
    expect(steps(out.plans)).toEqual(want)
    expect(out.plans[3].given.goTo).toBe('/tmp/gnomon-x/Outbox')
    expect(out.plans[6]).toMatchObject({ thing: { role: 'button', name: 'Save' }, given: { saveTo: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' } })
    // One step with no steps list is the same plan, for the gate as for the act.
    expect(steps((await screenAsk('screen_act', { app: 'TextEdit', action: 'save-as', value: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' }, PANEL_STATE, panelLook)).plans)).toEqual(want)
  })

  it('go-to-folder is the first four; a path that is not whole, or a save-as with no file name, is refused before anything runs', async () => {
    expect(steps((await planAll({ app: 'TextEdit', steps: [{ action: 'go-to-folder', value: '~/Documents/Outbox/' }] }, STATE, noLook)).plans)).toEqual([['key', 'cmd+shift+g'], ['key', 'cmd+a'], ['type', '~/Documents/Outbox'], ['key', 'return']])
    expect(panelSteps({ action: 'go-to-folder', value: 'Outbox' }).error).toMatch(/^invalid arguments: go-to-folder takes value, the whole path/)
    expect(panelSteps({ action: 'save-as', value: '/tmp/gnomon-x/Outbox' }).error).toMatch(/save-as takes the whole path of the file/)
    expect((await planAll({ app: 'TextEdit', steps: [{ action: 'key', value: 'cmd+shift+s' }, { action: 'save-as', value: 'Outbox/x.txt' }] }, STATE, noLook)).error).toMatch(/^step 2: invalid arguments: save-as/)
  })
})

describe('the gate: cmd+shift+g in a Save or Open panel is navigation', () => {
  const judge = (look, app = 'TextEdit') => finalOf('screen_act', { app, action: 'save-as', value: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' }, undefined, judgedPlans(panelSteps({ action: 'save-as', value: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' }, null, true).map((s) => planOf(s, app)), look))
  const planOf = (s, app) => ({ verb: s.action, app, thing: s.label ? { role: s.role, name: s.label } : { name: '' }, command: { value: s.value } })

  it('the look shows the panel in front: the path, its Return, the name and Save are no final', () => {
    expect(savePanel(PANEL)).toBe(true)
    expect(judge(PANEL)).toBeNull()
    // An Open panel: an Open button, no name field.
    expect(judge({ ...PANEL, focused: null, elements: [{ ...SAVE, label: 'Open' }] })).toBeNull()
  })

  it('outside a panel it is unchanged: cmd+shift+g then Return asks final-unknown (the T19 wall); a save-changes alert is no panel', () => {
    expect(judge({ ...PANEL, dialog: false })?.kind).toBe('final-unknown')
    expect(judge(null)?.kind).toBe('final-unknown')
    const alert = { ...PANEL, focused: null, elements: [SAVE, { ...SAVE, ref: 'e3', label: "Don't Save", default: false }] }
    expect(savePanel(alert)).toBe(false)
    expect(judge(alert)?.kind).toBe('final-unknown')
    // A panel of another app's look does not count for this one.
    expect(judge(PANEL, 'Zen')?.kind).toBe('final-unknown')
  })

  it('a Replace after the Save is still a final', () => {
    const plans = judgedPlans([{ verb: 'press', app: 'TextEdit', thing: { role: 'button', name: 'Replace' }, command: {} }], PANEL)
    expect(finalOf('screen_act', { app: 'TextEdit', role: 'button', label: 'Replace' }, undefined, plans)?.kind).toBe('overwrite')
  })

  // S5R3 (doc 29, runs 248 and 249): a Return or Save in the panel the look shows writes a new file: no final, wherever the keyboard is.
  const own = (look, list, app = 'TextEdit') => finalOf('screen_act', { app, steps: list }, undefined, judgedPlans(list.map((s) => planOf(s, app)), look))
  it('a Return in a shown Save or Open panel is its Save or Open, after a tab or on a row with no words too', () => {
    expect(own(PANEL, [{ action: 'key', value: 'tab' }, { action: 'key', value: 'return' }])).toBeNull()
    expect(own({ ...PANEL, focused: 'e4', elements: [SAVE, FIELD, { ref: 'e4', role: 'AXRow', label: '', frame: [300, 400, 100, 20] }] }, [{ action: 'key', value: 'return' }])).toBeNull()
    expect(own(PANEL, [{ action: 'key', value: 'cmd+shift+g' }, { action: 'type', value: '/tmp/gnomon-x/Outbox' }, { action: 'key', value: 'return' }, { action: 'type', value: 'Juniper.txt' }, { action: 'key', value: 'return' }])).toBeNull()
    const open = { ...PANEL, focused: null, elements: [{ ...SAVE, label: 'Open' }, { ref: 'e5', role: 'AXButton', label: 'Cancel', frame: [500, 520, 60, 24], enabled: true }] }
    expect(own(open, [{ action: 'key', value: 'shift+tab' }, { action: 'key', value: 'return' }])).toBeNull()
  })

  it('fail closed: a Return after the panel closed in the same call, and a panel the look does not show, still ask', () => {
    expect(own(PANEL, [{ action: 'key', value: 'return' }, { action: 'key', value: 'return' }])?.kind).toBe('final-unknown')
    expect(own({ ...PANEL, dialog: false }, [{ action: 'key', value: 'tab' }, { action: 'key', value: 'return' }])?.kind).toBe('final-unknown')
    expect(own(null, [{ action: 'key', value: 'tab' }, { action: 'key', value: 'return' }])?.kind).toBe('final-unknown')
  })

  it('a Replace confirmation over the panel, or a save-as onto a file that is there, asks as an overwrite', () => {
    const replace = { ...PANEL, focused: null, elements: [{ ...SAVE, default: false }, FIELD, { ...SAVE, ref: 'e6', label: 'Replace', default: true }] }
    expect(own(replace, [{ action: 'key', value: 'return' }])?.kind).toBe('overwrite')
    const dir = mkdtempSync(join(tmpdir(), 'gnomon-x-'))
    try {
      writeFileSync(join(dir, 'Juniper.txt'), 'juniper')
      const save = (name) => { const list = panelSteps({ action: 'save-as', value: join(dir, name) }, null, true); return finalOf('screen_act', { app: 'TextEdit', steps: list }, undefined, judgedPlans(list.map((s) => ({ ...planOf(s, 'TextEdit'), given: s })), PANEL)) }
      expect(save('Juniper.txt')).toMatchObject({ kind: 'overwrite', what: `Save, over the file already at ${join(dir, 'Juniper.txt')}` })
      expect(save('Kestrel.txt')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('save-as with no panel in the look says why it asks (run 248 T21)', () => {
    const list = panelSteps({ action: 'save-as', value: '/tmp/gnomon-x/Outbox/Brief Kestrel.txt' }, null, true)
    const final = finalOf('screen_act', { app: 'TextEdit', steps: list }, undefined, judgedPlans(list.map((s) => ({ ...planOf(s, 'TextEdit'), given: s })), { ...PANEL, dialog: false }))
    expect(final).toMatchObject({ kind: 'final-unknown', why: 'the last look of TextEdit shows no Save or Open panel in front: open it and look before save-as or go-to-folder' })
  })

  it('the look of a panel tells the model the step, and the no-keys way that works by hand (doc 30: both save-where passes)', () => {
    const said = format({ ...PANEL, processName: undefined })
    expect(said).toMatch(/It is a Save or Open panel: to save there, one step \{app, action: "save-as", value: "\/the\/folder\/name\.ext"\}; to go to a folder, \{app, action: "go-to-folder"/)
    expect(said).toContain('Keys and typing do not reach it; clicks, presses and set-value do: by hand, click down the folders of the path in its column browser (a folder a click does not open takes a double-click: {ref, action: "click", count: 2}), set-value its name field, then press its Save button.')
    expect(said).not.toMatch(/Never the Where pop-up or the column browser/)
  })
})

describe('the Return in the go-to field', () => {
  const ret = { verb: 'key', app: 'TextEdit', thing: { name: '' }, command: { value: 'return' }, given: { goTo: '/tmp/gnomon-x/Outbox' } }
  it('changed nothing: the keys missed the panel, the chain stops before Save; never the default button by name', async () => {
    let pressed = false
    const r = await pressDefault(ret, { same: true, text: '' }, async () => PANEL, async () => { pressed = true; return {} })
    expect(pressed).toBe(false)
    expect(r).toMatchObject({ reason: 'panel-keys' })
    expect(r.refused).toMatch(/^refused: nothing on screen changed after the Return in the TextEdit panel's "Go to the folder" field/)
    expect(await pressDefault(ret, { same: false, text: '' }, async () => PANEL, async () => ({}))).toEqual({ same: false, text: '' })
  })
})

describe('the save check names the folder', () => {
  const since = Date.now()
  const dir = mkdtempSync(join(tmpdir(), 'gnomon-x-'))
  const [outbox, drafts] = [join(dir, 'Outbox'), join(dir, 'Drafts')]
  mkdirSync(outbox)
  mkdirSync(drafts)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const plans = (to) => [{ verb: 'press', app: 'TextEdit', thing: { role: 'button', name: 'Save' }, command: {}, given: { saveTo: to } }]
  const front = (path) => () => ({ window: { active: { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt', documentPath: path } } })

  it('the file is in the named folder: said so, with the folder', async () => {
    const to = join(outbox, 'Brief Kestrel.txt')
    writeFileSync(to, 'kestrel')
    expect(await saveProof(plans(to), { files: async () => [], since, state: front(to), ms: 50 })).toBe(`\nSave check: on disk "${to}" was written since this call: it landed in the named folder "${outbox}".`)
  })

  it('it landed elsewhere (the folder the panel remembered): said plainly', async () => {
    const to = join(outbox, 'Juniper.txt')
    const there = join(drafts, 'Juniper.txt')
    writeFileSync(there, 'juniper')
    expect(await saveProof(plans(to), { files: async () => [], since, state: front(`file://${there}`), ms: 50 })).toBe(`\nSave check: it did NOT land in the named folder "${outbox}": nothing was written at "${to}", and "${there}" was written since this call. Say plainly that it landed there, not in the folder asked for.`)
    expect(await saveProof(plans(join(outbox, 'Nothing.txt')), { files: async () => [], since, state: front(null), ms: 50 })).toMatch(/no file change was seen on disk or in the log in 0\.05 s for ".*\/Outbox\/Nothing\.txt"/)
  })
})

// S5R4 (runs 248 T19 and T21): save-as with no panel in the last look opens it by the app's own File menu first. Made-up values only.
const DOC = { id: 'look-0000d0c5', app: 'TextEdit', window: 'Brief Kestrel.txt', dialog: false, focused: 'e9', menus: ['TextEdit', 'File', 'Edit', 'Format', 'View', 'Window', 'Help'], elements: [{ ref: 'e9', role: 'AXTextArea', label: '', value: 'Kestrel notes', frame: [0, 60, 800, 600], enabled: true, settable: true }] }
// The title bar's rename popover: Name, Tags, Where; no Cancel. Even with a Save button in the look it is no panel.
const POPOVER = { ...DOC, id: 'look-0000a0a0', dialog: true, focused: 'e3', elements: [{ ref: 'e3', role: 'AXTextField', label: 'Name:', value: 'Brief Kestrel', frame: [300, 30, 200, 22], enabled: true, settable: true }, { ref: 'e4', role: 'AXTextField', label: 'Tags:', value: '', frame: [300, 60, 200, 22], enabled: true, settable: true }, { ref: 'e5', role: 'AXPopUpButton', label: 'Where:', value: 'Drafts', frame: [300, 90, 200, 22], enabled: true }, { ...SAVE, ref: 'e6' }] }
const TO = '/tmp/gnomon-x/Outbox/Brief Kestrel.txt'

describe('save-as with no Save panel in the last look opens it first', () => {
  const GO = [['key', 'cmd+shift+g'], ['key', 'cmd+a'], ['type', '/tmp/gnomon-x/Outbox'], ['key', 'return'], ['key', 'cmd+a'], ['type', 'Brief Kestrel.txt'], ['press', 'Save']]

  it('a plain document: open-panel, then the go-to steps; a panel in the look: none; go-to-folder never opens one', async () => {
    const [state, read] = seenAs(DOC)
    const out = await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, state, read)
    expect(steps(out.plans)).toEqual([['open-panel', 'undefined'], ...GO])
    expect(out.plans[0]).toMatchObject({ verb: 'open-panel', app: 'TextEdit', line: 'Open the Save panel of TextEdit by its File menu', given: { value: TO } })
    expect(steps((await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, PANEL_STATE, panelLook)).plans)).toEqual(GO)
    expect(steps((await planAll({ app: 'TextEdit', steps: [{ action: 'go-to-folder', value: '/tmp/gnomon-x/Outbox' }] }, state, read)).plans)[0]).toEqual(['key', 'cmd+shift+g'])
  })

  it('the title bar rename popover is no panel: save-as opens the real one', async () => {
    expect(savePanel(POPOVER)).toBe(false)
    expect(savePanel({ ...POPOVER, elements: [...POPOVER.elements, { ...SAVE, ref: 'e7', label: 'Cancel', default: false }] })).toBe(true)
    const [state, read] = seenAs(POPOVER)
    expect(steps((await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, state, read)).plans)[0][0]).toBe('open-panel')
  })

  it('the gate: opening the panel and a new file saved in it are no final; a save over a file that is there asks', async () => {
    const [state, read] = seenAs(DOC)
    const judge = async (to) => {
      const { plans } = await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: to }] }, state, read)
      return finalOf('screen_act', { app: 'TextEdit', action: 'save-as', value: to }, undefined, judgedPlans(plans, DOC))
    }
    expect(await judge(TO)).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'gnomon-x-'))
    try {
      writeFileSync(join(dir, 'Juniper.txt'), 'juniper')
      expect(await judge(join(dir, 'Juniper.txt'))).toMatchObject({ kind: 'overwrite' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Without the open-panel the same keys on the document still ask (fail closed).
    const list = panelSteps({ action: 'save-as', value: TO }, null, true).map((s) => ({ verb: s.action, app: 'TextEdit', thing: s.label ? { role: s.role, name: s.label } : { name: '' }, command: { value: s.value }, given: s }))
    expect(finalOf('screen_act', { app: 'TextEdit', action: 'save-as', value: TO }, undefined, judgedPlans(list, DOC))?.kind).toBe('final-unknown')
  })

  it('the opener comes from the File menu the app lists: Save As, else Duplicate then Save, else Export only for another extension', () => {
    expect(openerOf(['New', 'Open…', 'Save…', 'Save As…', 'Duplicate'], TO, 'Brief Kestrel.txt')).toEqual(['Save As…'])
    expect(openerOf(['New', 'Save…', 'Duplicate', 'Rename…', 'Export as PDF…'], TO, 'Brief Kestrel.txt')).toEqual(['Duplicate', 'Save…'])
    expect(openerOf(['New', 'Export…'], '/tmp/gnomon-x/Outbox/Kestrel.png', 'Kestrel.heic')).toEqual(['Export…'])
    expect(openerOf(['New', 'Export…'], '/tmp/gnomon-x/Outbox/Kestrel.heic', 'Kestrel.heic')).toBeNull()
    expect(openerOf(['New', 'Close'], TO, 'Brief Kestrel.txt')).toBeNull()
  })
})

describe('openPanel: a pick-menu by the File menu, then a fresh look must show the panel', () => {
  const plan = { verb: 'open-panel', app: 'TextEdit', thing: { name: 'Save panel' }, command: {}, given: { app: 'TextEdit', value: TO } }
  const run = (looks, items) => {
    const [picked, asked, last] = [[], [], looks.at(-1)]
    const deps = { menu: async (path) => (asked.push(path), items), act: async (p) => (picked.push(p.command.target.label), { same: false }), lookIn: async () => looks.shift() ?? last, pause: async () => {} }
    return { picked, asked, out: openPanel(plan, deps) }
  }

  it('Duplicate then Save, the copy in front, the panel shown: done, nothing typed by it', async () => {
    const t = run([DOC, { ...DOC, window: 'Brief Kestrel copy' }, PANEL], ['New', 'Save…', 'Duplicate'])
    expect(await t.out).toMatchObject({ same: false, note: 'TextEdit shows its Save panel, opened by "File > Duplicate" then "File > Save…"' })
    expect(t.asked).toEqual(['File'])
    expect(t.picked).toEqual(['File > Duplicate', 'File > Save…'])
  })

  // Run 251 T19: the pick was unkept, so no screen:step row told the fold this task opened the panel, and leftModal refused the next key.
  it('the pick is kept as this task\'s own step (a screen:step row), so the steps after it are not refused as a sheet it did not open', async () => {
    const kept = []
    const deps = { menu: async () => ['Save As…'], act: async (p) => (kept.push(p.unkept), { same: false }), lookIn: (() => { const looks = [DOC, PANEL]; return async () => looks.shift() ?? PANEL })(), pause: async () => {} }
    await openPanel(plan, deps)
    expect(kept).toEqual([undefined])
  })

  it('a panel already in front is used as it is', async () => {
    const t = run([PANEL], [])
    expect(await t.out).toMatchObject({ note: 'TextEdit already shows its Save panel' })
    expect(t.picked).toEqual([])
  })

  it('stops: no panel after the pick, no new window after Duplicate (no Save on the original), no opener in the menu', async () => {
    expect((await run([DOC, DOC, POPOVER], ['Save As…']).out).refused).toBe('refused: TextEdit did not open a Save panel; the file was not saved (no Save panel showed after "File > Save As…"). Nothing was typed. Look at TextEdit and tell the owner.')
    const dup = run([DOC, DOC], ['Save…', 'Duplicate'])
    expect((await dup.out).refused).toMatch(/after "File > Duplicate" no new window was in front, so Save was not picked/)
    expect(dup.picked).toEqual(['File > Duplicate'])
    expect((await run([DOC], ['New', 'Close']).out).refused).toMatch(/its File menu lists no Save As, Duplicate and Save, or Export: "New", "Close"/)
  })
})

/** A fake TextEdit for screen_act: `panel` says whether a pick-menu brings its Save panel; `sent` lists what went to the app. */
function textEdit(panel, keys = true) {
  const [sent, rows, kept] = [[], { [DOC.id]: lookForLog(DOC) }, []]
  const state = { config: { experiments: { screenAct: true, screenPanelKeys: keys } }, window: { active: { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt', windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: DOC.id, app: 'TextEdit' } } }
  let [n, screen] = [0, DOC]
  // Every look is a little changed, so each act reads as done.
  const shown = (id, more = {}) => {
    const [first, ...rest] = screen.elements.filter((e) => e.role !== 'AXButton').concat(screen.elements.filter((e) => e.role === 'AXButton'))
    rows[id] = { ...lookForLog({ ...screen, id, elements: [{ ...first, value: `Kestrel ${++n}` }, ...rest] }), ...more }
    state.marks.lastLook = { id, app: 'TextEdit', ...more }
  }
  const send = (c) => {
    sent.push(c.type === 'act' ? `${c.action} ${c.target?.label ?? c.value ?? ''}`.trim() : c.type)
    if (c.type === 'look') return shown(c.id)
    if (c.type !== 'act') return
    if (c.action === 'pick-menu' && panel) screen = PANEL
    state.marks.lastAct = c.action === 'list-menu' ? { id: c.id, outcome: 'refused', reason: 'submenu', names: ['New', 'Save…', 'Save As…'] } : { id: c.id, outcome: 'performed' }
    if (c.action !== 'list-menu') shown(`look-after-${c.id}`, { after: c.id })
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((row) => row[field] === id) ?? null
  const [, , act] = screenTools(async (type, row) => { if (type === 'screen:step') kept.push([row.verb, row.screenText[0]]) }, () => state, send, readRow, async () => [], { proofMs: 20 })
  return { sent, kept, run: (args) => act.execute(args).then((v) => v, (e) => e.message) }
}
const acts = (sent) => sent.filter((s) => /^(pick-menu|key|list-menu|type|AXPress)\b/.test(s))

describe('screen_act: save-as from a plain document', () => {
  it('the File menu read, Save As picked, the panel seen, then the go-to steps', async () => {
    const t = textEdit(true)
    const out = await t.run({ app: 'TextEdit', action: 'save-as', value: TO })
    expect(acts(t.sent)).toEqual(['list-menu File', 'pick-menu File > Save As…', 'key cmd+shift+g', 'key cmd+a', 'type /tmp/gnomon-x/Outbox', 'key return', 'key cmd+a', 'type Brief Kestrel.txt', 'AXPress'])
    expect(out).toMatch(/^1\. Open the Save panel of TextEdit by its File menu: done\. TextEdit shows its Save panel, opened by "File > Save As…"\n2\. /)
    // Run 251 T19: the pick is a kept step, so the fold knows this task opened the panel (leftModal lets the next step go).
    expect(t.kept[0]).toEqual(['pick-menu', 'File > Save As…'])
  }, 15_000)

  it('the panel never shows: the chain stops before cmd+shift+g, and the answer says the file was not saved', async () => {
    const t = textEdit(false)
    const out = await t.run({ app: 'TextEdit', action: 'save-as', value: TO })
    expect(acts(t.sent)).toEqual(['list-menu File', 'pick-menu File > Save As…'])
    expect(out).toMatch(/^1\. Open the Save panel of TextEdit by its File menu: refused: TextEdit did not open a Save panel; the file was not saved \(no Save panel showed after "File > Save As…"\)/)
    expect(out).toMatch(/Stopped at step 1: steps 2 to 8 did not run\./)
  }, 15_000)
})

// Doc 31 (runs 254 to 257, 4 of 4): the look that came with the pick of "File > Save As…" held the panel's sheet ("save"), its
// columns, its Where pop-up and its name field, but not yet its Save and Cancel buttons (57 to 61 parts against 97 a second later),
// so it said nothing of a Save panel, and run 255 T21 sent keys. The shape as the app read it, with made-up values.
const HALF = {
  id: 'look-0000ha1f', app: 'TextEdit', window: 'Untitled (Brief Kestrel copy)', dialog: true, focused: 'e84', menus: ['TextEdit', 'File'],
  elements: [
    { ref: 'e47', role: 'AXSheet', label: 'save', value: '', in: 'dialog', frame: [80, 160, 880, 450], enabled: true },
    { ref: 'e60', role: 'AXBrowser', label: '', value: '', in: 'save', frame: [100, 260, 840, 200], enabled: true },
    { ref: 'e61', role: 'AXTextField', label: '', value: 'Drafts', in: 'column view', frame: [110, 270, 160, 18], enabled: true },
    { ref: 'e80', role: 'AXPopUpButton', label: 'Where:', value: 'Drafts', in: 'save', frame: [400, 220, 220, 22], enabled: true },
    { ref: 'e84', role: 'AXTextField', label: '', value: 'Brief Kestrel copy.txt', in: 'save', frame: [400, 180, 220, 22], enabled: true, settable: true },
  ],
}
describe('doc 31: the first look after the panel opens says it is a Save panel', () => {
  it('a sheet still drawing, with its Where pop-up and name field and no Save button yet, is the panel, and its line is given', () => {
    expect(savePanel(HALF)).toBe(true)
    expect(format(HALF)).toContain('It is a Save or Open panel: to save there, one step {app, action: "save-as"')
  })

  it("Finder's Go to Folder sheet and a lock alert are no panel; neither is the title bar popover", () => {
    const goTo = { ...HALF, app: 'Finder', elements: [{ ref: 'e1', role: 'AXSheet', label: '/tmp/gnomon-x/Box', in: 'dialog', frame: [0, 0, 400, 100], enabled: true }, { ref: 'e2', role: 'AXTextField', label: '', value: '/tmp/gnomon-x/Box', frame: [10, 10, 300, 22], enabled: true }] }
    const alert = { ...HALF, elements: [{ ref: 'e1', role: 'AXSheet', label: 'alert', in: 'dialog', frame: [0, 0, 400, 100], enabled: true }, { ref: 'e2', role: 'AXButton', label: 'Duplicate', frame: [10, 60, 80, 22], enabled: true }] }
    expect([goTo, alert, POPOVER].map(savePanel)).toEqual([false, false, false])
  })
})

// Doc 31: every save-where turn sent cmd+shift+s (in TextEdit a copy with the title bar's rename popover), then tried the popover's
// Where pop-up 3 or 4 times (10 tries, none opened), 6 to 8 calls lost a turn. Run 257 read it as a popover, not a dialog. Made-up values.
const POPPED = {
  id: 'look-0000c0de', app: 'TextEdit', window: 'Brief Kestrel copy 2', focused: 'e41', menus: ['TextEdit', 'File'],
  elements: [
    { ref: 'e39', role: 'AXPopover', label: 'Name:, Tags:, Where:', value: '', frame: [300, 30, 260, 120], enabled: true },
    { ref: 'e41', role: 'AXTextField', label: '', value: 'Brief Kestrel copy 2', in: 'popover', frame: [360, 40, 180, 22], enabled: true, settable: true },
    { ref: 'e43', role: 'AXTextField', label: 'tag editor', value: '', in: 'popover', frame: [360, 70, 180, 22], enabled: false },
    { ref: 'e45', role: 'AXPopUpButton', label: '', value: 'Drafts', in: 'popover', frame: [360, 100, 180, 22], enabled: false },
  ],
}
describe('doc 31: the title bar popover says it is no Save panel, and points to save-as', () => {
  const LINE = "This is the title bar's rename popover (Name, Tags, Where), not a Save panel: its Where pop-up does not open"
  it('as run 257 read it (a popover) and as run 248 did (a dialog with a "Name:" field and no Cancel)', () => {
    for (const look of [POPPED, POPOVER]) {
      expect(savePanel(look)).toBe(false)
      expect(format(look)).toContain(LINE)
      expect(format(look)).toContain('one step {app, action: "save-as", value: "/the/folder/name.ext"}: it opens the real Save panel by the File menu (Save As…, or Duplicate then Save)')
    }
  })

  it('a real Save panel, whole or still drawing, and a plain document carry no such line', () => {
    for (const look of [PANEL, HALF, DOC]) expect(format(look)).not.toContain(LINE)
  })
})

// Doc 32 (run 258 T19): Finder's Go to Folder came up holding the last run's path, and the typed path went in behind it.
describe('doc 32: a path after cmd+shift+g replaces what the go-to field holds', () => {
  const FINDER = { config: { experiments: { screenAct: true } }, marks: { now: [], guideTally: {} } }
  const go = [{ app: 'Finder', action: 'key', value: 'cmd+shift+g' }, { app: 'Finder', action: 'type', value: '/tmp/gnomon-x/Outbox' }, { app: 'Finder', action: 'key', value: 'return' }]
  it('Finder: cmd+a before the typed path (past a wait), replace on a set-value; no other type is touched', async () => {
    const { plans } = await planAll({ app: 'Finder', steps: go }, FINDER, noLook)
    expect(steps(plans)).toEqual([['key', 'cmd+shift+g'], ['key', 'cmd+a'], ['type', '/tmp/gnomon-x/Outbox'], ['key', 'return']])
    // Select all leaves the keyboard in the field: the Return there is still Go to Folder's, no final.
    expect(finalOf('screen_act', { app: 'Finder', steps: go }, undefined, judgedPlans(plans, null))).toBeNull()
    expect(await panelList([go[0], { action: 'wait', seconds: 1 }, go[1]])).toEqual([go[0], { action: 'wait', seconds: 1 }, { app: 'Finder', action: 'key', value: 'cmd+a' }, go[1]])
    expect(await panelList([go[0], { action: 'set-value', ref: 'e5@f1d0', value: '/tmp/gnomon-x/Outbox' }])).toEqual([go[0], { action: 'set-value', ref: 'e5@f1d0', value: '/tmp/gnomon-x/Outbox', replace: true }])
    expect(await panelList([go[0], { action: 'type', value: 'Outbox' }, go[1]])).toEqual([go[0], { action: 'type', value: 'Outbox' }, go[1]])
    // A call already at 8 steps gets no ninth.
    const full = [...go, ...Array(5).fill({ action: 'wait', seconds: 1 })]
    expect(await panelList(full)).toEqual(full)
  })
})
