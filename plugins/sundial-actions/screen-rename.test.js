import { describe, expect, it } from 'vitest'
import { asRename, fileIn, fileNamed, renameIn, renamePlan } from './screen-rename.js'
import { actPlan, screenAsk, screenTools } from './screen-tools.js'

// A Finder list view as lookOf reads it (made up): a row, its always-there name field, a date; and the search field.
const el = (ref, role, label, value, frame, extra = {}) => ({ ref, role, sub: role === 'AXRow' ? 'AXOutlineRow' : '', label, value, in: 'list view', frame, settable: role === 'AXTextField', actions: [], ...extra })
const LIST = (name, over = {}) => ({
  id: 'look-1', tag: 'a1b2', app: 'Finder', window: 'Testbox-correct', focused: 'e50',
  elements: [
    el('e2', 'AXTextField', 'search', '', [900, 220, 160, 22], { in: 'toolbar' }),
    el('e54', 'AXRow', 'Today at 15:41, 12 bytes, Plain Text', '', [666, 298, 612, 20]),
    el('e55', 'AXTextField', '', name, [712, 299, 60, 18]),
    el('e56', 'AXStaticText', '', 'Today at 15:41', [875, 299, 169, 18]),
  ],
  ...over,
})

describe('Finder rename as one step (runs 186 and 190: the rename never completed)', () => {
  it('finds the file by its name field, its row or its name, and selects it by the row', () => {
    expect(fileIn(LIST('notes.txt'), 'e55')).toMatchObject({ name: 'notes.txt', select: { ref: 'e54' } })
    expect(fileIn(LIST('notes.txt'), 'e54')).toMatchObject({ name: 'notes.txt', select: { ref: 'e54' } })
    expect(fileIn(LIST('notes.txt'), 'e56')).toBeNull()
    expect(fileNamed(LIST('notes.txt'), 'notes.txt')).toBe('e55')
  })

  it('selects by the file\'s own row, never the sidebar row on the same line (runs 191, 193: the click opened "Shared")', () => {
    const side = { ...LIST('notes.txt') }
    side.elements = [el('e3', 'AXRow', 'Shared', '', [440, 297, 226, 32], { in: 'sidebar' }), ...side.elements]
    expect(fileIn(side, 'e55')).toMatchObject({ name: 'notes.txt', select: { ref: 'e54' } })
    expect(fileIn(side, 'e3')).toBeNull()
  })

  it('plans one step the owner reads, and refuses another app, a bad name or no file', () => {
    expect(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt')).toMatchObject({ verb: 'rename', line: 'Rename "notes.txt" to "Kestrel.txt" in Finder', rename: { old: 'notes.txt', to: 'Kestrel.txt', window: 'Testbox-correct', select: { look: 'look-1', ref: 'e54', action: 'click' } } })
    expect(renamePlan(LIST('notes.txt'), 'e55', 'a/b.txt').error).toMatch(/no \/ or :/)
    expect(renamePlan(LIST('notes.txt'), 'e55', 'x.txt', 'TextEdit').error).toMatch(/Finder step/)
    expect(renamePlan(LIST('notes.txt'), 'e9', 'x.txt').error).toMatch(/no file in Finder/)
  })

  it('the model\'s own chain (click the name, cmd+a, type, Return: run 186) becomes the one rename; any other chain is left alone', async () => {
    const p = (verb, command, more = {}) => ({ verb, app: 'Finder', thing: { name: verb }, line: verb, command, given: { verb }, ...more })
    const chain = [p('click', { look: 'look-1', ref: 'e55', action: 'click' }), p('key', { value: 'cmd+a' }), p('type', { value: 'Kestrel.txt' }), p('key', { value: 'return' })]
    const read = async (id) => (id === 'look-1' ? LIST('notes.txt') : null)
    expect((await asRename(chain, read)).map((x) => x.verb)).toEqual(['rename'])
    // Run 190: the type step carried the field's ref too.
    expect((await asRename([chain[0], p('type', { look: 'look-1', ref: 'e55', value: 'Kestrel.txt' }), chain[3]], read)).map((x) => x.verb)).toEqual(['rename'])
    // Run 181: the menu's Rename in place of Return.
    expect((await asRename([chain[0], p('pick-menu', { value: 'File > Rename' }, { thing: { name: 'File > Rename' } }), chain[2]], read)).map((x) => x.verb)).toEqual(['rename'])
    const search = [p('click', { look: 'look-1', ref: 'e2', action: 'click' }), p('type', { value: 'notes' })]
    expect((await asRename(search, read)).map((x) => x.verb)).toEqual(['click', 'type'])
    expect((await asRename([{ ...chain[0], app: 'TextEdit' }, chain[2]], read)).map((x) => x.verb)).toEqual(['click', 'type'])
  })

  it('run 206 T19: a type straight into a file\'s name field (no click), then Return, is the one rename too; the search field is not', async () => {
    const p = (verb, command) => ({ verb, app: 'Finder', thing: { name: verb }, line: verb, command, given: { verb } })
    const read = async (id) => (id === 'look-1' ? LIST('notes.txt') : null)
    const done = await asRename([p('type', { look: 'look-1', ref: 'e55', action: 'type', value: 'Kestrel.txt' }), p('key', { value: 'return' })], read)
    expect(done.map((x) => x.verb)).toEqual(['rename'])
    expect(done[0].rename).toMatchObject({ old: 'notes.txt', to: 'Kestrel.txt', select: { ref: 'e54' } })
    expect((await asRename([p('set-value', { look: 'look-1', ref: 'e55', value: 'Kestrel.txt' })], read)).map((x) => x.verb)).toEqual(['rename'])
    // The search field holding words is no file's name; a type into it stays a type.
    const search = async () => LIST('notes.txt', { elements: [el('e2', 'AXTextField', 'search', 'notes', [900, 220, 160, 22], { in: 'toolbar' })] })
    expect((await asRename([p('type', { look: 'look-1', ref: 'e2', value: 'notes' }), p('key', { value: 'return' })], search)).map((x) => x.verb)).toEqual(['type', 'key'])
  })

  // Run 198 frames: Return opened the box with "notes" selected and ".txt" not, and the look after it listed no box (its focus
  // named no part); cmd+a then closed the box, and the name went to the file list.
  const NOBOX = (over = {}) => LIST('notes.txt', { id: 'look-2', focused: undefined, ...over })
  const runWith = async (to, looks, rows = []) => {
    const sent = []
    const asked = []
    const perform = async (plan) => (sent.push([plan.verb, plan.command.ref ?? plan.command.value, plan.unkept]), { text: '' })
    const lookIn = async (app, window) => (asked.push([app, window]), looks.shift())
    const r = await renameIn(renamePlan(LIST('notes.txt'), 'e55', to), { perform, lookIn, appendSignal: async (type, row) => rows.push([type, row]) }, '', 'rename a file', 's1')
    return { sent, asked, r }
  }

  it('runs select, Return, the base name typed into the box (no cmd+a, the extension kept), Return, and proves it by the names listed', async () => {
    const rows = []
    const { sent, asked, r } = await runWith('Kestrel.txt', [NOBOX(), LIST('Kestrel.txt', { id: 'look-3' })], rows)
    expect(sent).toEqual([['click', 'e54', true], ['key', 'return', true], ['type', 'Kestrel', true], ['key', 'return', true]])
    expect(asked).toEqual([['Finder', 'Testbox-correct'], ['Finder', 'Testbox-correct']])
    expect(r.text).toBe('Renamed "notes.txt" to "Kestrel.txt" in Finder: the folder now lists "Kestrel.txt" and no "notes.txt".')
    expect(rows).toEqual([['screen:step', expect.objectContaining({ verb: 'rename', screenText: ['notes.txt'], typed: 11, goal: 'rename a file', ok: true, changed: true })]])
  })

  it('another extension: shift+cmd+right takes the unselected extension too, then the whole name', async () => {
    const { sent } = await runWith('notes-done.md', [NOBOX(), LIST('notes-done.md', { id: 'look-3' })])
    expect(sent.map(([v, x]) => [v, x])).toEqual([['click', 'e54'], ['key', 'return'], ['key', 'shift+cmd+right'], ['type', 'notes-done.md'], ['key', 'return']])
  })

  it('the keyboard still in the file list after Return: no box opened, nothing typed, escape, and the answer says what to do', async () => {
    const { sent, r } = await runWith('Kestrel.txt', [NOBOX({ focused: 'e54' })])
    expect(sent.map(([v, x]) => [v, x])).toEqual([['click', 'e54'], ['key', 'return'], ['key', 'escape']])
    expect(r).toMatchObject({ reason: 'no-rename-box', refused: expect.stringMatching(/nothing was typed.*Next: send this same step once more, \{app: "Finder", action: "rename", label: "notes\.txt", value: "Kestrel\.txt"\}/) })
  })

  it('the owner\'s Stop between the Return and the typing: nothing typed, Escape closes the box, the step is refused stopped (run 215 T18)', async () => {
    const stop = new AbortController()
    const sent = []
    const perform = async (plan) => (sent.push([plan.verb, plan.command.ref ?? plan.command.value]), plan.command.value === 'return' && stop.abort(), { text: '' })
    const r = await renameIn(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt'), { perform, lookIn: async () => NOBOX({ focused: 'e90' }), appendSignal: async () => {}, signal: stop.signal }, '', '', 's1')
    expect(sent).toEqual([['click', 'e54'], ['key', 'return'], ['key', 'escape']])
    expect(r).toMatchObject({ reason: 'stopped', refused: expect.stringMatching(/stopped the turn, so "notes\.txt" was not renamed\. Escape was pressed/) })
    // Stopped before its first act: nothing at all is sent.
    const none = []
    await renameIn(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt'), { perform: async (plan) => (none.push(plan.verb), { text: '' }), lookIn: async () => null, appendSignal: async () => {}, signal: stop.signal }, '', '', 's1')
    expect(none).toEqual([])
  })

  it('the Stop after the new name went in: the folder is read again, and the name it lists is the answer (run 219 T18: 2 said, 3 on disk)', async () => {
    for (const [listed, ok] of [['Kestrel.txt', true], ['notes.txt', false]]) {
      const stop = new AbortController()
      const sent = []
      const rows = []
      const perform = async (plan) => (sent.push([plan.verb, plan.command.ref ?? plan.command.value]), plan.verb === 'type' && stop.abort(), { text: '' })
      const looks = [NOBOX(), LIST(listed, { id: 'look-3' })]
      const r = await renameIn(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt'), { perform, lookIn: async () => looks.shift(), appendSignal: async (type, row) => rows.push(row), signal: stop.signal }, '', '', 's1')
      expect(sent).toEqual([['click', 'e54'], ['key', 'return'], ['type', 'Kestrel'], ['key', 'escape']])
      expect(rows.map((row) => [row.ok, row.reason])).toEqual([ok ? [true, undefined] : [false, 'stopped']])
      expect(r.refused === undefined).toBe(ok)
      if (ok) expect(r.text).toBe('Renamed "notes.txt" to "Kestrel.txt" in Finder: the folder now lists "Kestrel.txt" and no "notes.txt".')
    }
  })

  // The app build after run 198 lists the focused rename box itself (ScreenLook.swift focusedPart), first and marked.
  const BOX = (value, over = {}) => {
    const look = NOBOX({ focused: 'e90', ...over })
    look.elements = [el('e90', 'AXTextField', '', value, [700, 350, 64, 18], { in: 'icon view', focused: true }), ...look.elements]
    return look
  }

  it('the look lists the focused box: its value is set to the whole new name, no keys typed', async () => {
    const { sent } = await runWith('Kestrel.txt', [BOX('notes.txt'), LIST('Kestrel.txt', { id: 'look-3' })])
    expect(sent).toEqual([['click', 'e54', true], ['key', 'return', true], ['set-value', 'e90', true], ['key', 'return', true]])
  })

  it('the box is set to the whole name, or to the base name when it shows no extension (hidden in Finder) and the extension stays', async () => {
    const valueSet = async (box) => {
      const values = []
      const looks = [box, LIST('Kestrel.txt', { id: 'look-3' })]
      await renameIn(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt'), { perform: async (plan) => (values.push([plan.verb, plan.command.value]), { text: '' }), lookIn: async () => looks.shift(), appendSignal: async () => {} }, '', '', 's1')
      return values.find(([v]) => v === 'set-value')?.[1]
    }
    expect(await valueSet(BOX('notes.txt'))).toBe('Kestrel.txt')
    expect(await valueSet(BOX('notes'))).toBe('Kestrel')
  })

  it('a focused field without the file\'s name (the search field) is no rename box: nothing set or typed', async () => {
    const { sent, r } = await runWith('Kestrel.txt', [BOX('quarterly')])
    expect(sent.map(([v, x]) => [v, x])).toEqual([['click', 'e54'], ['key', 'return'], ['key', 'escape']])
    expect(r.reason).toBe('no-rename-box')
  })

  it('not renamed: escape, and the answer names the folder\'s files (never the sidebar\'s icons) and the one next step', async () => {
    const side = LIST('notes.txt', { id: 'look-3' })
    side.elements = [el('e4', 'AXImage', 'clock', '', [458, 276, 22, 11], { in: 'sidebar' }), ...side.elements]
    const { sent, r } = await runWith('Kestrel.txt', [NOBOX(), side])
    expect(sent.at(-1)).toEqual(['key', 'escape', true])
    expect(r.reason).toBe('rename-not-seen')
    expect(r.refused).toMatch(/the folder lists "notes\.txt", so "notes\.txt" was not renamed/)
    expect(r.refused).not.toContain('clock')
    expect(r.refused).toMatch(/if it fails again, stop and tell the owner.*Never rebuild it from clicks, Return, cmd\+a/)
  })

  it('screen_act says several files are one rename step each, never a chain or the shell (run 198 T17)', () => {
    const [, , act] = screenTools(async () => {}, () => ({ config: { experiments: {} }, marks: {} }), () => {}, async () => null, async () => [], {})
    expect(act.description).toMatch(/Several files: one rename step each, in one call/)
    expect(act.description).toMatch(/never a click, Return, cmd\+a and type chain, and never the shell's mv/)
  })

  it('screen_act takes it by ref or by name, and the chain the owner is asked about is the one rename', async () => {
    const raw = (ref, role, label, value, frame) => ({ ref, role, sub: role === 'AXRow' ? 'AXOutlineRow' : '', screenText: [label, value, 'list view'], frame, settable: role === 'AXTextField', enabled: true, actions: [] })
    const ROW = { id: 'look-0000aaaa', tag: 'aaaa', processName: 'Finder', windowTitle: 'Testbox-correct', elements: [raw('e54', 'AXRow', 'Today at 15:41, 12 bytes, Plain Text', '', [666, 298, 612, 20]), raw('e55', 'AXTextField', '', 'notes.txt', [712, 299, 60, 18])] }
    const state = { config: { experiments: {} }, marks: { lastLook: { id: ROW.id, app: 'Finder', n: 2 } } }
    const readLook = async (id) => ([ROW.id, ROW.tag].includes(id) ? ROW : null)
    expect(await actPlan({ app: 'Finder', action: 'rename', ref: 'e55@aaaa', value: 'Kestrel.txt' }, state, readLook)).toMatchObject({ verb: 'rename', rename: { old: 'notes.txt', to: 'Kestrel.txt', select: { ref: 'e54' } } })
    expect(await actPlan({ app: 'Finder', action: 'rename', label: 'notes.txt', value: 'Kestrel.txt' }, state, readLook)).toMatchObject({ verb: 'rename', rename: { old: 'notes.txt' } })
    const asked = await screenAsk('screen_act', { app: 'Finder', steps: [{ ref: 'e55@aaaa', action: 'click' }, { action: 'key', value: 'cmd+a' }, { action: 'type', value: 'Kestrel.txt' }, { action: 'key', value: 'return' }] }, state, readLook)
    expect(asked.line).toBe('Rename "notes.txt" to "Kestrel.txt" in Finder')
  })

  it('Set 5 R1 (plan 2F): the owner\'s Stop between the click and the Return: no Return, Escape, refused stopped', async () => {
    const stop = new AbortController()
    const sent = []
    const perform = async (plan) => (sent.push([plan.verb, plan.command.ref ?? plan.command.value]), plan.verb === 'click' && stop.abort(), { text: '' })
    const r = await renameIn(renamePlan(LIST('notes.txt'), 'e55', 'Kestrel.txt'), { perform, lookIn: async () => null, appendSignal: async () => {}, signal: stop.signal }, '', '', 's1')
    expect(sent).toEqual([['click', 'e54'], ['key', 'escape']])
    expect(r).toMatchObject({ reason: 'stopped' })
  })
})
