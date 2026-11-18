import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { boxRole, defaultFinal } from './default-final.js'
import { lookOf } from './screen-look.js'

const el = (ref, role, label, more = {}) => ({ ref, role, sub: '', label, value: '', frame: [100, 100, 200, 22], actions: [], settable: false, enabled: true, in: '', ...more })
// A Finder sheet: "Replace" is its default button, Cancel its cancel button.
const sheet = (more = {}, extra = {}) => ({
  id: 'look-1', app: 'Finder', window: 'Puzzlebox', tag: 'ab12', focused: 'e1', dialog: true, defaultButton: { ref: 'e3' },
  elements: [
    el('e1', 'AXTextField', 'Save As', { settable: true, value: 'BOX-484 notes' }),
    el('e2', 'AXButton', 'Cancel', { actions: ['AXPress'], cancel: true }),
    el('e3', 'AXButton', 'Replace', { actions: ['AXPress'], default: true, ...more }),
    el('e4', 'AXTextField', 'Search', { sub: 'AXSearchField', settable: true }),
    el('e5', 'AXComboBox', 'Where', { settable: true }),
    el('e6', 'AXTextArea', 'Comments', { settable: true }),
    el('e7', 'AXTextField', 'Password', { sub: 'AXSecureTextField', settable: true }),
  ],
  ...extra,
})

describe('defaultFinal: a Return in a native one-line field presses the window\'s default button', () => {
  it('the field with the keyboard, a ref, a part or a plan\'s thing gives the default button', () => {
    expect(defaultFinal(sheet())?.ref).toBe('e3')
    expect(defaultFinal(sheet(), 'e1')?.label).toBe('Replace')
    expect(defaultFinal(sheet(), sheet().elements[0])?.ref).toBe('e3')
    expect(defaultFinal(sheet(), { role: 'text field', name: 'Save As' })?.ref).toBe('e3')
    expect(defaultFinal(sheet(), 'e7')?.ref).toBe('e3')
  })

  it('a search field, a combo box or a text area keeps its Return: null', () => {
    for (const ref of ['e4', 'e5', 'e6']) expect(defaultFinal(sheet(), ref)).toBeNull()
  })

  it('S5R1: a button, a checkbox, nothing focused, or a ref the look does not hold passes Return to the default button', () => {
    for (const ref of ['e2', 'e3', 'e99']) expect(defaultFinal(sheet(), ref)?.ref).toBe('e3')
    expect(defaultFinal(sheet(), { role: 'check box', name: 'Hide extension' })?.ref).toBe('e3')
    expect(defaultFinal(sheet({}, { focused: undefined }))?.ref).toBe('e3')
    expect(defaultFinal(sheet(), null)?.ref).toBe('e3')
  })

  it('no default button, or one that is off, presses nothing: null', () => {
    expect(defaultFinal(sheet({ default: false }, { defaultButton: undefined }))).toBeNull()
    expect(defaultFinal(sheet({ enabled: false }))).toBeNull()
    expect(defaultFinal(null)).toBeNull()
  })

  it('the mark alone is enough (the window-level name may be gone), and a page\'s field is a web form\'s, not the window\'s', () => {
    expect(defaultFinal(sheet({}, { defaultButton: undefined }))?.ref).toBe('e3')
    const page = sheet({}, { app: 'Safari', elements: [el('e9', 'AXWebArea', 'Puzzlebox', { frame: [0, 0, 800, 600] }), ...sheet().elements] })
    expect(defaultFinal(page)).toBeNull()
    expect(defaultFinal(sheet(), el('e8', 'AXTextField', 'Subject', { in: 'web area' }))).toBeNull()
  })

  it('reads a look from the log as lookOf gives it back', () => {
    const row = { id: 'look-1', processName: 'Finder', windowTitle: 'Puzzlebox', focused: 'e1', defaultButton: { ref: 'e3' }, elements: [
      { ref: 'e1', role: 'AXTextField', sub: '', frame: [100, 100, 200, 22], actions: [], settable: true, screenText: ['Save As', 'BOX-484 notes', ''] },
      { ref: 'e3', role: 'AXButton', sub: '', frame: [300, 200, 80, 22], actions: ['AXPress'], default: true, screenText: ['Replace', '', ''] },
    ] }
    expect(defaultFinal(lookOf(row))?.label).toBe('Replace')
  })
})

describe('boxRole: a group, an unknown or a web area that takes text is a text area', () => {
  it('by its role description or editable mark first, by settable as a fallback; any other role is its own', () => {
    expect(boxRole(el('e1', 'AXGroup', 'Message #kettle-room', { roleDescription: 'text entry area' }))).toBe('text area')
    expect(boxRole(el('e1', 'AXWebArea', '', { editable: true }))).toBe('text area')
    expect(boxRole(el('e1', 'AXGroup', '', { settable: true }))).toBe('text area')
    expect(boxRole(el('e1', 'AXGroup', '', { roleDescription: 'group' }))).toBe('group')
    expect(boxRole(el('e1', 'AXButton', 'Send', { roleDescription: 'message', editable: true }))).toBe('button')
  })

  it('the role description goes through the log as a screen word and comes back on its part', () => {
    const look = { id: 'look-2', app: 'Quill', window: 'kettle-room', elements: [el('e5', 'AXGroup', 'Message #kettle-room', { roleDescription: 'text entry area', editable: true }), el('e6', 'AXButton', 'Send', { actions: ['AXPress'] })] }
    const row = lookForLog(look)
    expect(row.elements[0]).toMatchObject({ editable: true, screenText: ['Message #kettle-room', '', '', 'text entry area'] })
    expect(row.elements[0].roleDescription).toBeUndefined()
    expect(row.elements[1].screenText).toEqual(['Send', '', ''])
    const back = lookOf(row).elements
    expect(back[0]).toMatchObject({ roleDescription: 'text entry area', editable: true })
    expect(back[1].roleDescription).toBeUndefined()
    expect(boxRole(back[0])).toBe('text area')
  })
})
