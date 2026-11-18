// S5R2 (plan 2H): a line break inside `type` is split into type, Return, type in an editor's text area, and still refused in
// a chat's box, a terminal or any field whose Return can send. Made-up values only.
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { returnAddsLine } from './gate-finals.js'
import { actPlan, screenTools } from './screen-tools.js'
import { finalOf, judgedPlans } from './gate-finals.js'
import { lookOf } from './screen-look.js'

const BODY = { ref: 'e40', role: 'AXTextArea', sub: '', label: '', value: 'Brief Kestrel', frame: [10, 60, 600, 400], actions: [], settable: true, enabled: true }
const SEND = { ref: 'e41', role: 'AXButton', sub: '', label: 'Send', value: '', frame: [620, 430, 60, 24], actions: ['AXPress'], settable: false, enabled: true }
const lookIn = (app, window, elements, id) => lookForLog({ id, at: '2026-11-16T09:00:00.000Z', app, bundleId: `com.example.${app.toLowerCase()}`, window, frame: [0, 25, 1440, 875], focused: 'e40', menus: ['File', 'Edit'], source: 'ax', truncated: false, elements })
const EDITOR = lookIn('TextEdit', 'Brief Kestrel.txt', [BODY], 'look-0000ed17')
const CHAT = lookIn('Slack', 'general', [{ ...BODY, label: 'Message #general' }, SEND], 'look-0000c4a7')
const TERM = lookIn('Terminal', 'zsh', [BODY], 'look-00007e37')
const ROWS = [EDITOR, CHAT, TERM]
const readLook = async (id, { field = 'id' } = {}) => ROWS.find((r) => (field === 'tag' ? String(r.id).endsWith(id) : r[field] === id)) ?? null
const stateOf = (row) => ({ config: { experiments: {} }, marks: { lastLook: { id: row.id, app: row.processName, n: 1 } } })
const tagOf = (row) => row.id.slice(-4)

describe('a line break inside type (plan 2H)', () => {
  it('returnAddsLine: a document editor\'s text area in its look only; never a chat, a terminal, a field, or a box with its Send beside it', () => {
    const area = { role: 'text area' }
    const seen = lookOf(EDITOR)
    expect(returnAddsLine('TextEdit', seen, seen.elements[0])).toBe(true)
    expect(returnAddsLine('Slack', null, area)).toBe(false)
    expect(returnAddsLine('Terminal', null, area)).toBe(false)
    expect(returnAddsLine('TextEdit', null, { role: 'text field' })).toBe(false)
    expect(returnAddsLine('Zen', null, area)).toBe(false)
  })

  it('review S5R2 M1: no look is a no; a code editor\'s terminal or chat box, and a box labelled to run or send, are none', () => {
    const area = { role: 'text area' }
    expect(returnAddsLine('TextEdit', null, area)).toBe(false)
    expect(returnAddsLine('Visual Studio Code', null, area)).toBe(false)
    const code = lookOf(lookIn('Code', 'gate.js', [{ ...BODY, label: 'Terminal 1, zsh' }], 'look-0000c0de'))
    expect(returnAddsLine('Code', code, code.elements[0])).toBe(false)
    for (const [label, within] of [['Ask anything', ''], ['', 'Chat'], ['Prompt', ''], ['', 'Console'], ['Message', '']]) {
      const seen = lookOf(lookIn('Notes', 'Kestrel', [{ ...BODY, label, in: within }], 'look-0000a0a0'))
      expect(returnAddsLine('Notes', seen, seen.elements[0]), `${label} ${within}`).toBe(false)
    }
    // A Send-type button beside the area: its Return may send, whatever the app.
    const sends = lookOf(lookIn('Notes', 'Kestrel', [BODY, { ...SEND, label: 'Post', frame: [10, 465, 60, 24] }], 'look-0000a0a1'))
    expect(returnAddsLine('Notes', sends, sends.elements[0])).toBe(false)
    // The element must be the look's own, never a plan's word.
    expect(returnAddsLine('TextEdit', lookOf(EDITOR), area)).toBe(false)
  })

  it('in an editor\'s text area the step plans as one type that keeps its lines; in a chat or a terminal it is refused', async () => {
    const plan = await actPlan({ ref: `e40@${tagOf(EDITOR)}`, action: 'type', value: 'first\nsecond' }, stateOf(EDITOR), readLook)
    expect(plan).toMatchObject({ verb: 'type', lines: true, app: 'TextEdit', command: { ref: 'e40', value: 'first\nsecond' } })
    // Review S5R2 M1: by name, with no look of the app, the role is the call's own word: refused.
    expect((await actPlan({ app: 'TextEdit', role: 'text area', action: 'type', value: 'a\nb' }, { config: { experiments: {} }, marks: {} }, readLook)).error).toMatch(/a line break in type presses Return/)
    // A bare type goes to the field the look has the keyboard in: the text area.
    expect(await actPlan({ app: 'TextEdit', action: 'type', value: 'a\nb' }, stateOf(EDITOR), readLook)).toMatchObject({ lines: true })
    // Review S5R2 L2: 40 lines at most.
    expect(await actPlan({ ref: `e40@${tagOf(EDITOR)}`, action: 'type', value: Array(40).fill('kestrel').join('\n') }, stateOf(EDITOR), readLook)).toMatchObject({ lines: true })
    expect((await actPlan({ ref: `e40@${tagOf(EDITOR)}`, action: 'type', value: Array(41).fill('kestrel').join('\n') }, stateOf(EDITOR), readLook)).error).toMatch(/a type holds at most 40 lines: send a longer text as set-value/)
    for (const row of [CHAT, TERM]) expect((await actPlan({ ref: `e40@${tagOf(row)}`, action: 'type', value: 'a\nb' }, stateOf(row), readLook)).error).toMatch(/a line break in type presses Return/)
  })

  /** screen_act over one app: each look asked for comes back as `looks()` says (the app's look just before the act), each act as the editor's after-look. */
  const run = (looks) => {
    const sent = []
    const state = { ...stateOf(EDITOR), window: { active: { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt', windowId: 'w1' } } }
    const rows = {}
    const send = (command) => {
      if (command.type === 'look') {
        const row = { ...looks(), id: command.id }
        rows[command.id] = row
        state.marks.lastLook = { id: command.id, app: 'TextEdit', n: 1 }
        sent.push(['look'])
        return
      }
      if (command.type !== 'act') return
      sent.push([command.action, command.value, command.ref ?? null])
      state.marks.lastAct = { id: command.id, outcome: 'performed' }
      const id = `look-after-${command.id}`
      rows[id] = { ...EDITOR, id, after: command.id }
      state.marks.lastLook = { id, after: command.id, app: 'TextEdit', n: 1 }
    }
    const read = async (id, opts = {}) => (opts.field === 'after' ? Object.values(rows).find((r) => r.after === id) : rows[id]) ?? readLook(id, opts)
    const [, , act] = screenTools(async () => {}, () => state, send, read, async () => [])
    return { act, sent }
  }

  it('review S5R2 H1: runs as ONE type act holding its line breaks, after a look of the app just before it', async () => {
    const { act, sent } = run(() => EDITOR)
    await act.execute({ ref: `e40@${tagOf(EDITOR)}`, action: 'type', value: 'one\n\nthree' })
    expect(sent).toEqual([['look'], ['type', 'one\n\nthree', 'e40']])
  })

  it('review S5R2 H1: a sheet that took the keyboard after the last look: nothing typed, no Return pressed, refused', async () => {
    const SHEET = lookIn('TextEdit', 'Brief Kestrel.txt', [{ ...BODY, ref: 'e2', role: 'AXTextField', label: 'Save As:' }, { ...SEND, label: 'Save' }], 'look-00005a7e')
    for (const now of [{ ...SHEET, dialog: true }, { ...EDITOR, windowTitle: 'Untitled 2' }, { ...EDITOR, elements: [{ ...BODY, role: 'AXTextField' }] }]) {
      const { act, sent } = run(() => now)
      await expect(act.execute({ ref: `e40@${tagOf(EDITOR)}`, action: 'type', value: 'first\nsecond' })).rejects.toThrow(/^refused: nothing typed, no Return pressed/)
      expect(sent).toEqual([['look']])
    }
  })
})

describe('review S5R2 H1: the gate judges a type with a line break as that type, then key return at its thing', () => {
  const plan = (row, ref, value, role = 'text area', name = '') => ({ verb: 'type', app: row.processName, thing: { role, name }, command: { look: row.id, ref, value } })
  it('a box with its Send beside it: a send, asked; one line is no final', () => {
    const QUILL = lookIn('Quill', 'kettle-room', [{ ...BODY, ref: 'e5', label: 'Message #kettle-room', in: 'composer' }, { ...SEND, ref: 'e6', frame: [615, 430, 30, 30], in: 'composer' }], 'look-0000a111')
    const seen = lookOf(QUILL)
    const final = finalOf('screen_act', { ref: 'e5@a111', action: 'type', value: 'hi\nthere' }, undefined, judgedPlans([plan(QUILL, 'e5', 'hi\nthere', 'text area', 'Message #kettle-room')], seen))
    expect(final).toMatchObject({ kind: 'send', app: 'Quill' })
    expect(finalOf('screen_act', { ref: 'e5@a111', action: 'type', value: 'hi there' }, undefined, judgedPlans([plan(QUILL, 'e5', 'hi there', 'text area', 'Message #kettle-room')], seen))).toBeNull()
  })
  it('a sheet\'s field whose Return presses a Send: that final; unreadable: final-unknown; an editor\'s text area: none', () => {
    const sheet = (label) => ({ ...lookIn('Lantern', 'Share BOX-484', [{ ...BODY, ref: 'e1', role: 'AXTextField', label: 'Note to Mira', frame: [100, 100, 300, 22] }, { ...SEND, ref: 'e3', label, default: true }], 'look-0000b222'), dialog: true, focused: 'e1', defaultButton: { ref: 'e3' } })
    const send = sheet('Send')
    expect(finalOf('screen_act', {}, undefined, judgedPlans([plan(send, 'e1', 'a\nb', 'text field', 'Note to Mira')], lookOf(send)))).toMatchObject({ kind: 'send' })
    const blank = { ...sheet(''), focused: undefined }
    expect(finalOf('screen_act', {}, undefined, judgedPlans([{ verb: 'type', app: 'Lantern', thing: {}, command: { target: { app: 'Lantern' }, value: 'a\nb' } }], lookOf(blank)))).toMatchObject({ kind: 'final-unknown' })
    expect(finalOf('screen_act', {}, undefined, judgedPlans([plan(EDITOR, 'e40', 'a\nb')], lookOf(EDITOR)))).toBeNull()
  })
})
