// S5R2 (plan 3.5): a save or a rename by screen is said with the log's `file:changed` row behind it, or said unseen; never
// "saved" without a row. Made-up values only.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { lookOf } from './screen-look.js'
import { renameProof } from './screen-rename.js'
import { changesOf, saveProof, saves } from './screen-proof.js'
import { screenTools } from './screen-tools.js'

const key = (value, app = 'TextEdit') => ({ verb: 'key', app, thing: { name: value }, command: { value } })
const pick = (name, app = 'TextEdit') => ({ verb: 'pick-menu', app, thing: { name }, command: {} })
const press = (name, app = 'TextEdit') => ({ verb: 'press', app, thing: { role: 'button', name }, command: {} })
const SAVE_BUTTON = { ref: 'e9', role: 'AXButton', sub: '', label: 'Save', value: '', frame: [500, 400, 60, 24], actions: ['AXPress'], settable: false, enabled: true, default: true }
const SHEET = lookForLog({ id: 'look-0000f00d', at: '2026-11-16T09:00:00.000Z', app: 'TextEdit', bundleId: 'com.apple.TextEdit', window: 'Brief Kestrel.txt', frame: [0, 25, 1440, 875], focused: null, menus: ['File'], source: 'ax', truncated: false, elements: [SAVE_BUTTON] })
const row = (relPath, kind = 'modify', projectRoot = '~/Projects/puzzlebox-studio') => ({ capturedAt: '2026-11-16T09:00:03.000Z', data: { projectRoot, changes: [{ relPath, kind, size: 12 }], focused: true } })
const front = (documentPath, windowTitle = 'Brief Kestrel.txt') => () => ({ window: { active: { processName: 'TextEdit', windowTitle, documentPath } } })

describe('which steps write a file', () => {
  it('cmd+s, a Save item or a native Save button, a sheet opened and then committed; never a sheet left open or a web page\'s Save', async () => {
    expect(await saves([key('cmd+s')])).toBe(true)
    expect(await saves([key('Command + S')])).toBe(true)
    expect(await saves([pick('File > Save')])).toBe(true)
    expect(await saves([press('Save')])).toBe(true)
    expect(await saves([key('cmd+shift+s')])).toBe(false)
    expect(await saves([pick('File > Save As…')])).toBe(false)
    expect(await saves([key('cmd+shift+s'), { verb: 'type', app: 'TextEdit', thing: {}, command: { value: 'Brief Kestrel' } }, key('return')])).toBe(true)
    expect(await saves([press('Save', 'Zen')])).toBe(false)
    expect(await saves([key('cmd+c')])).toBe(false)
    // A lone Return saves when the app's look as the call began shows a sheet whose default button is Save.
    expect(await saves([key('return')], async () => lookOf(SHEET))).toBe(true)
    expect(await saves([key('return', 'Notes')], async () => lookOf(SHEET))).toBe(false)
    expect(await saves([key('return')], async () => null)).toBe(false)
  })

  it('changesOf reads a row as the log keeps it, each change with its whole path', () => {
    expect(changesOf([row('fix/run9/Brief Kestrel.txt', 'add')])).toEqual([{ path: '~/Projects/puzzlebox-studio/fix/run9/Brief Kestrel.txt', kind: 'add' }])
  })
})

describe('the save check', () => {
  const since = Date.now()
  // Review S5R2 M4: a real file in a folder no project watches, written now; and one written before the call.
  const dir = mkdtempSync(join(tmpdir(), 'gnomon-proof-'))
  const doc = join(dir, 'Brief Kestrel.txt')
  writeFileSync(doc, 'kestrel')
  const old = join(dir, 'Old Juniper.txt')
  writeFileSync(old, 'juniper')
  utimesSync(old, new Date(since - 60_000), new Date(since - 60_000))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('review S5R2 M4: the disk proves the front document written, in a folder no project watches; a row of the same path is a second witness', async () => {
    expect(await saveProof([key('cmd+s')], { files: async () => [], since, state: front(encodeURI(`file://${doc}`)), ms: 50 })).toBe(`\nSave check: on disk "${doc}" was written since this call: that is where it landed.`)
    expect(await saveProof([key('cmd+s')], { files: async () => [row('Brief Kestrel.txt', 'modify', dir)], since, state: front(doc), ms: 50 })).toMatch(/was written since this call, and the log's file row shows it too: that is where it landed\.$/)
  })

  it('review S5R2 M4: a row of another file by the same name is no proof; with no path, a row by name is only "a file by that name"', async () => {
    const files = async () => [row('notes/other.txt'), row('fix/run9/Old Juniper.txt')]
    expect(await saveProof([key('cmd+s')], { files, since, state: front(old, 'Old Juniper.txt'), ms: 50 })).toMatch(/^\nSave check: no file change was seen on disk or in the log in 0\.05 s for ".*Old Juniper\.txt"\. Do not say it is saved/)
    // No document path (an app that gives none): the window's title, with its extension hidden.
    const named = await saveProof([key('cmd+s')], { files, since, state: front(null, 'Old Juniper \u2014 Edited'), ms: 50 })
    expect(named).toBe('\nSave check: the window gives no path; the log\'s file row shows a file by that name written since this call, "~/Projects/puzzlebox-studio/fix/run9/Old Juniper.txt". Look at the window before you say where it landed.')
  })

  it('with no proof, says no file change was seen and not to call it saved', async () => {
    const line = await saveProof([key('cmd+s')], { files: async () => [row('notes/other.txt')], since, state: front('~/Documents/Brief Kestrel.txt'), ms: 50 })
    expect(line).toMatch(/^\nSave check: no file change was seen on disk or in the log in 0\.05 s for "~\/Documents\/Brief Kestrel\.txt"\. Do not say it is saved/)
    expect(await saveProof([key('cmd+c')], { files: async () => [], since, state: front(null), ms: 50 })).toBe('')
  })

  it('a save through screen_act ends its answer with the check', async () => {
    const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt', documentPath: doc } }, marks: {} }
    const send = (command) => {
      if (command.type !== 'act') return
      // The app writes its document on cmd+s, unless this save fails.
      if (command.value === 'cmd+s' && !state.fails) writeFileSync(state.window.active.documentPath, 'kestrel')
      state.marks = { ...state.marks, lastAct: { id: command.id, outcome: 'performed' }, lastLook: { id: `look-after-${command.id}`, after: command.id, refused: 'no-window' } }
    }
    const read = async () => null
    const run = async (call = { app: 'TextEdit', action: 'key', value: 'cmd+s' }) => {
      const [, , act] = screenTools(async () => {}, () => state, send, read, async () => [], { files: async () => [], proofMs: 50 })
      return act.execute(call)
    }
    expect(await run()).toMatch(/\nSave check: on disk ".*Brief Kestrel\.txt" was written since this call/)
    state.fails = true
    state.window.active.documentPath = old
    expect(await run()).toMatch(/\nSave check: no file change was seen/)
    state.fails = false
    state.window.active.documentPath = doc
    // In a chain: the check comes once, after the steps that ran.
    const chain = await run({ app: 'TextEdit', steps: [{ action: 'key', value: 'cmd+a' }, { action: 'key', value: 'cmd+s' }] })
    expect(chain.match(/Save check/g)).toHaveLength(1)
    expect(await run({ app: 'TextEdit', steps: [{ action: 'key', value: 'cmd+a' }, { action: 'key', value: 'cmd+c' }] })).not.toMatch(/Save check/)
  })
})

describe('the rename check', () => {
  const since = Date.now()
  const renames = [{ old: 'Brief Kestrel.txt', to: 'Brief Juniper.txt' }]
  it('a row that adds the new name, and on disk the new name and not the old', async () => {
    const files = async () => [row('fix/run9/Brief Kestrel.txt', 'delete'), row('fix/run9/Brief Juniper.txt', 'add')]
    const on = (names) => (path) => names.some((n) => path.endsWith(`/fix/run9/${n}`))
    expect(await renameProof(renames, { files, since, ms: 50, exists: on(['Brief Juniper.txt']) })).toBe('\nRename check: the log\'s file row shows "~/Projects/puzzlebox-studio/fix/run9/Brief Juniper.txt" added; on disk it exists and "Brief Kestrel.txt" does not.')
    expect(await renameProof(renames, { files, since, ms: 50, exists: on(['Brief Juniper.txt', 'Brief Kestrel.txt']) })).toMatch(/but on disk "Brief Kestrel\.txt" still exists too: look at the folder/)
  })

  it('no row: the folder\'s look is the only proof; no rename or no reader: nothing', async () => {
    expect(await renameProof(renames, { files: async () => [], since, ms: 50 })).toMatch(/^\nRename check: no file row for "Brief Juniper\.txt" in the log/)
    expect(await renameProof([], { files: async () => [], since, ms: 50 })).toBe('')
    expect(await renameProof(renames, { since, ms: 50 })).toBe('')
  })
})
