// Finals (2026-11-14): an act that cannot be taken back asks in every preset and every mode, test mode
// included; a blind one is refused. A private app is never opened, raised or acted in. Every value is made up.
import { afterEach, describe, expect, it } from 'vitest'
import { callFacts, commandLine, decideAction, finalAsk, finalOf, judgedPlans, keyboardLook, recipientsOf } from './gate.js'
import { lookOf } from './screen-look.js'
import { screenAsk } from './screen-tools.js'
import { routeReplay } from './screen-pick.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { applyPrivacyConfig } from '@sundial/helpers/privacy-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
/** Nothing the gate does writes to the call's arguments: a write to a frozen object throws in a module. */
const freeze = (x) => {
  if (x && typeof x === 'object') Object.values(x).forEach(freeze)
  return x && typeof x === 'object' ? Object.freeze(x) : x
}
/** As index.js decides: frozen arguments, facts from them (and the plans a ref press resolved to), the preset, test mode and the owner's dial. */
const decide = (toolName, args, { preset, testMode, autonomy, approvalOverride, plans, webElement } = {}) =>
  decideAction({ toolName, args: freeze(args), preset, approvalOverride, actions, resolveActionPolicy, autonomy, testMode, facts: callFacts({ toolName, args, plans, webElement }) })

const MAIL = `osascript -e 'tell application "Microsoft Outlook"' -e 'set m to make new outgoing message with properties {subject:"Hi", content:"kestrel 4821"}' -e 'tell m to make new to recipient at end of to recipients with properties {address:"test@example.com"}' -e 'send m' -e 'end tell'`
const page = { p1: [{ ref: 1, role: 'button', name: 'Send' }, { ref: 2, role: 'button', name: 'Place order' }, { ref: 3, role: 'button', name: 'Delete' }, { ref: 4, role: 'button', name: 'Discard draft' }, { ref: 5, role: 'button', name: 'Buy now' }, { ref: 6, role: 'button', name: 'Publish' }, { ref: 7, role: 'textbox', name: 'Confirm email' }, { ref: 8, role: 'button', name: 'Next' }, { ref: 9, role: 'button', name: 'Install Update' }, { ref: 10, role: 'button', name: 'Remind Me Later' }] }
const webElement = (id, ref) => page[id]?.find((e) => e.ref === ref) ?? null
const web = (ref) => ({ page: 'p1', ref, action: 'click', because: 'Next step' })

/** Per kind: calls that take it, through the screen (by label, menu, key, find, or a ref the plan names), the web and the shell. */
const FINALS = {
  send: [['screen_act', { app: 'Zen', role: 'button', label: 'Send' }], ['screen_act', { app: 'Zen', action: 'key', value: 'cmd+enter' }], ['web_act', web(1)], ['gnomon_run_shell', { command: MAIL }], ['bash', { command: MAIL }]],
  submit: [['screen_act', { app: 'Zen', role: 'button', label: 'Place order' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Submit' }], ['screen_act', { app: 'Zen', find: 'Confirm button', action: 'press' }], ['web_act', web(2)]],
  delete: [['screen_act', { app: 'Finder', action: 'pick-menu', value: 'Move to Trash' }], ['screen_act', { app: 'Finder', action: 'pick-menu', value: 'Empty Trash' }], ['screen_act', { app: 'Finder', action: 'key', value: 'cmd+backspace' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Remove' }], ['web_act', web(3)], ['gnomon_run_shell', { command: 'rm /tmp/gnomon-140/old/a.log' }], ['bash', { command: 'find /tmp/gnomon-140 -name "*.log" -delete' }]],
  discard: [['screen_act', { app: 'TextEdit', role: 'button', label: "Don't Save" }], ['screen_act', { app: 'TextEdit', role: 'button', label: 'Revert' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Delete draft' }], ['web_act', web(4)]],
  pay: [['screen_act', { app: 'Zen', role: 'button', label: 'Pay' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Buy now' }], ['screen_act', { app: 'Zen', role: 'link', label: 'Checkout' }], ['web_act', web(5)]],
  post: [['screen_act', { app: 'Zen', role: 'button', label: 'Post' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Reply all' }], ['web_act', web(6)]],
  update: [['screen_act', { app: 'Zen', role: 'button', label: 'Update' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Install Update' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Restart Now' }], ['screen_act', { app: 'Zen', role: 'button', label: 'Upgrade' }], ['screen_act', { app: 'Zen', find: 'Install button', action: 'press' }], ['web_act', web(9)]],
}
const PRESETS = [undefined, 'read-only', 'workspace-write', 'danger-full-access', 'custom']

describe('a final asks in every preset and every mode, test mode and Auto included', () => {
  it('kind x preset x test mode x dial: ask, or deny where the preset runs nothing; never allow', () => {
    let cells = 0
    for (const [kind, calls] of Object.entries(FINALS))
      for (const [toolName, args] of calls) {
        expect(finalOf(toolName, args, webElement)?.kind, `${toolName} ${JSON.stringify(args)}`).toBe(kind)
        for (const preset of PRESETS)
          for (const testMode of [false, true])
            for (const autonomy of [undefined, 'act']) {
              const decision = decide(toolName, args, { preset, testMode, autonomy, webElement })
              expect(decision.kind, `${kind} ${toolName} ${preset} test=${testMode} ${autonomy}`).toBe(preset === 'read-only' ? 'deny' : 'ask')
              if (decision.kind === 'ask') expect(decision.reason).toMatch(/cannot be taken back, so it asks you first/)
              cells += 1
            }
      }
    expect(cells).toBe(Object.values(FINALS).flat().length * PRESETS.length * 2 * 2)
  })

  it('a ref press is the final its look names: the plan carries the name the arguments do not', () => {
    const args = { ref: 'e3@ab12', action: 'press' }
    const plans = [{ verb: 'press', app: 'Zen', thing: { role: 'AXButton', name: 'Place order' } }]
    expect(finalOf('screen_act', args)).toBeNull()
    expect(finalOf('screen_act', args, undefined, plans)).toMatchObject({ kind: 'submit', app: 'Zen' })
    expect(decide('screen_act', args, { preset: 'danger-full-access', testMode: true, plans })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/submits a form/) })
    // A typed field or a tab whose name starts with a final's word is not a press.
    expect(finalOf('screen_act', args, undefined, [{ verb: 'tab', app: 'Zen', thing: { name: 'Delete account' } }, { verb: 'type', app: 'Zen', thing: { role: 'AXTextField', name: 'Post code' } }])).toBeNull()
  })

  it('Return, Enter or Space on a final is that final: a focus before it, or the keyboard already there (run 138)', () => {
    const key = (value) => ({ verb: 'key', app: 'Zen', thing: { name: '' }, command: { action: 'key', value } })
    const focus = (name, role = 'button') => ({ verb: 'focus', app: 'Zen', thing: { role, name } })
    const cells = [
      // The run 138 call: focus the Discard button by ref, then Return (the app as screen_act fills it in).
      [{ app: 'Zen', steps: [{ ref: 'e111@521ed7', action: 'focus' }, { action: 'key', value: 'return' }], goal: 'discard the draft' }, [focus('Discard'), key('return')], 'discard', 'Discard'],
      [{ app: 'Zen', steps: [{ ref: 'e112@521ed7', action: 'focus' }, { action: 'key', value: 'space' }] }, [focus('Delete'), key('space')], 'delete', 'Delete'],
      [{ app: 'Zen', steps: [{ ref: 'e113@521ed7', action: 'select' }, { action: 'key', value: 'kp_enter' }] }, [{ ...focus('Submit'), verb: 'select' }, key('kp_enter')], 'submit', 'Submit'],
      // The look already has the keyboard in the Send button: Return alone sends.
      [{ app: 'Zen', action: 'key', value: 'return' }, [{ verb: 'keyboard', app: 'Zen', thing: { role: 'button', name: 'Send' } }, key('return')], 'send', 'Send'],
      [{ app: 'Zen', steps: [{ action: 'wait', seconds: 1 }, { action: 'key', value: 'enter' }] }, [{ verb: 'keyboard', app: 'Zen', thing: { role: 'button', name: 'Send' } }, { verb: 'wait', app: 'Zen', thing: { name: '1 s' } }, key('enter')], 'send', 'Send'],
    ]
    for (const [args, plans, kind, on] of cells) {
      expect(finalOf('screen_act', args, undefined, plans), JSON.stringify(args)).toMatchObject({ kind, app: 'Zen', on })
      for (const preset of PRESETS)
        for (const testMode of [false, true])
          expect(decide('screen_act', args, { preset, testMode, plans }), `${kind} ${preset} ${testMode}`).toMatchObject(preset === 'read-only' ? { kind: 'deny' } : { kind: 'ask', reason: expect.stringMatching(/cannot be taken back, so it asks you first/) })
    }
    // The ask names what the key lands on, in the step line.
    const discard = finalOf('screen_act', cells[0][0], undefined, cells[0][1])
    expect(finalAsk(discard, { line: 'Focus "Discard" in Zen; then key in Zen: return' })).toBe(`Gnomon: this discards unsaved changes with return on "Discard" in Zen, which cannot be taken back, so it asks you first. Focus "Discard" in Zen; then key in Zen: return · final: discard`)
    expect(callFacts({ toolName: 'screen_act', args: cells[0][0], plans: cells[0][1] }).final).toEqual({ kind: 'discard', via: 'screen', blind: false })
    // Not a final: Return in a field, after a step that moves the keyboard, with nothing focused, or a Tab that only moves.
    for (const plans of [[focus('Delete account', 'text field'), key('return')], [focus('Discard'), { verb: 'click', app: 'Zen', thing: { role: 'button', name: 'Next' } }, key('return')], [key('return')], [focus('Send'), key('tab')]])
      expect(finalOf('screen_act', { app: 'Zen', action: 'key', value: 'return' }, undefined, plans), JSON.stringify(plans)).toBeNull()
  })

  it('Return after a key that moved the keyboard asks, fail-closed; the keyboard an act result reports counts (run 145)', () => {
    const key = (value) => ({ verb: 'key', app: 'Zen', thing: { name: '' }, command: { action: 'key', value } })
    const unknown = { kind: 'final-unknown', via: 'screen', blind: false, app: 'Zen' }
    // Run 145, call 1: one tab; its act result said `focus: e184 button "Delete the message from Mira Bakker"`. The fold keeps the chat's step.
    const first = { app: 'Zen', action: 'key', value: 'tab' }
    expect(finalOf('screen_act', first, undefined, [key('tab')])).toBeNull()
    const state = { marks: { lastLook: { id: 'look-9', app: 'Obsidian', n: 4 }, chats: { 'session-7f': { app: { app: 'Zen', at: 'T' }, step: { id: 'act-145', app: 'Zen', at: 'T' } } } } }
    // The last look is of another app: this chat's act result (its after-look) says where the keyboard is.
    expect(keyboardLook(state, 'session-7f', 'Zen')).toEqual({ id: 'act-145', field: 'after' })
    expect(keyboardLook({ marks: { ...state.marks, lastLook: { id: 'look-10', app: 'Zen', at: 'T2' } } }, 'session-7f', 'Zen')).toEqual({ id: 'look-10', at: 'T2' })
    expect(keyboardLook({ marks: { ...state.marks, lastLook: { id: 'look-11', app: 'Zen', refused: 'private app' } } }, 'session-7f', 'Zen')).toBeNull()
    expect(keyboardLook(state, 'session-other', 'Zen')).toBeNull()
    const held = { verb: 'keyboard', app: 'Zen', thing: { role: 'button', name: 'Delete the message from Mira Bakker' } }
    // Call 2: shift+tab, then Return. The keyboard moved off what was read: nobody knows what Return presses.
    const second = { app: 'Zen', steps: [{ action: 'key', value: 'shift+tab' }, { action: 'key', value: 'return' }] }
    for (const plans of [[held, key('shift+tab'), key('return')], [key('shift+tab'), key('return')], []]) {
      expect(finalOf('screen_act', second, undefined, plans), JSON.stringify(plans)).toEqual({ ...unknown, by: 'shift+tab', ...(plans[0] === held ? { last: held.thing.name } : {}) })
      for (const preset of PRESETS)
        for (const testMode of [false, true])
          expect(decide('screen_act', second, { preset, testMode, plans }), `${preset} ${testMode}`).toMatchObject(preset === 'read-only' ? { kind: 'deny' } : { kind: 'ask', reason: expect.stringMatching(/Return lands on a part Gnomon cannot read for certain/) })
    }
    expect(finalAsk(finalOf('screen_act', second, undefined, [key('shift+tab'), key('return')]), { line: 'Key in Zen: shift+tab; then key in Zen: return' })).toBe('Gnomon: this Return in Zen lands on a part Gnomon cannot read for certain (shift+tab moved the keyboard first): what it presses may not be taken back, so it asks you first. Key in Zen: shift+tab; then key in Zen: return · final: final-unknown')
    // Return alone on the Delete button the act result reported is that delete.
    expect(finalOf('screen_act', { app: 'Zen', action: 'key', value: 'return' }, undefined, [held, key('return')])).toMatchObject({ kind: 'delete', on: 'Delete the message from Mira Bakker' })
    // Tab, an arrow or any other key, then Return or Space, in one call.
    for (const [moves, enter] of [['tab', 'return'], ['down', 'enter'], ['escape', 'space'], ['cmd+[', 'kp_enter']]) {
      const args = { app: 'Zen', steps: [{ action: 'key', value: moves }, { action: 'wait', seconds: 1 }, { action: 'key', value: enter }] }
      expect(finalOf('screen_act', args, undefined, [key(moves), { verb: 'wait', app: 'Zen', thing: { name: '1 s' } }, key(enter)])?.kind, moves).toBe('final-unknown')
      expect(finalOf('screen_act', args)?.kind, `${moves} from the arguments`).toBe('final-unknown')
      expect(decide('screen_act', args, { preset: 'danger-full-access', testMode: true }).kind).toBe('ask')
    }
    expect(callFacts({ toolName: 'screen_act', args: second, plans: [] }).final).toEqual({ kind: 'final-unknown', via: 'screen', blind: false })
    // Return in a text field after typing is no final: typing known to land in a field (it names one, a focus on a field came first,
    // the look's keyboard is in one, or cmd+f or cmd+l opened one), even after a tab.
    const bare = { verb: 'type', app: 'Zen', thing: { name: '' }, command: { action: 'type', value: 'x' } }
    const field = { verb: 'type', app: 'Zen', thing: { role: 'text field', name: 'Message' }, command: { action: 'type', value: 'Thanks, see you Monday' } }
    const focused = { verb: 'focus', app: 'Zen', thing: { role: 'text field', name: 'Message' } }
    for (const plans of [[focused, field, key('return')], [focused, bare, key('return')], [field, key('return')], [key('tab'), field, key('return')], [key('tab'), focused, bare, key('return')], [{ verb: 'keyboard', app: 'Zen', thing: { role: 'AXTextField', name: 'Search' } }, bare, key('return')], [key('cmd+f'), bare, key('return')], [key('tab'), key('cmd+l'), bare, key('return')]])
      expect(finalOf('screen_act', { app: 'Zen', action: 'key', value: 'return' }, undefined, plans), JSON.stringify(plans)).toBeNull()
    expect(finalOf('screen_act', { app: 'Zen', steps: [{ action: 'key', value: 'cmd+f' }, { action: 'type', value: 'invoice' }, { action: 'key', value: 'return' }] })).toBeNull()
    // A bare type after a tab may land on a button, where it goes nowhere: Return then presses that button, so it asks.
    for (const plans of [[key('tab'), bare, key('return')], [held, key('tab'), bare, key('return')], [focused, key('tab'), bare, key('return')], [key('cmd+f'), key('tab'), bare, key('return')]])
      expect(finalOf('screen_act', { app: 'Zen', action: 'key', value: 'return' }, undefined, plans)?.kind, JSON.stringify(plans)).toBe('final-unknown')
    const tabTyped = { app: 'Zen', steps: [{ action: 'key', value: 'tab' }, { action: 'type', value: 'x' }, { action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', tabTyped)?.kind).toBe('final-unknown')
    expect(decide('screen_act', tabTyped, { preset: 'danger-full-access', testMode: true, plans: [key('tab'), bare, key('return')] })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/Return lands on a part Gnomon cannot read for certain/) })
  })

  it('a caret key inside a known text area keeps the keyboard there; the same arrow outside a field still asks (run 154)', () => {
    const key = (value) => ({ verb: 'key', app: 'Obsidian', thing: { name: '' }, command: { action: 'key', value } })
    const note = { verb: 'focus', app: 'Obsidian', thing: { role: 'text area', name: 'Note' } }
    const held = { verb: 'keyboard', app: 'Obsidian', thing: { role: 'AXTextArea', name: 'Note' } }
    const typed = { verb: 'type', app: 'Obsidian', thing: { role: 'text area', name: 'Note' }, command: { action: 'type', value: 'x' } }
    const args = { app: 'Obsidian', steps: [{ action: 'key', value: 'cmd+down' }, { action: 'key', value: 'return' }] }
    for (const plans of [[note, key('cmd+down'), key('return')], [held, key('cmd+down'), key('return')], [typed, key('down'), key('end'), key('alt+left'), key('page-down'), key('return')], [note, key('shift+cmd+up'), key('return'), key('down'), key('return')]]) {
      expect(finalOf('screen_act', args, undefined, plans), JSON.stringify(plans)).toBeNull()
      expect(decide('screen_act', args, { preset: 'danger-full-access', plans }).reason ?? '').not.toMatch(/final|Return lands/)
    }
    // Not in a field: an arrow in a list moves the selection, a tab leaves the field, ctrl+arrow switches Spaces. Return then asks.
    const row = { verb: 'select', app: 'Obsidian', thing: { role: 'row', name: 'Inbox' } }
    for (const plans of [[row, key('down'), key('return')], [key('down'), key('return')], [note, key('tab'), key('return')], [note, key('ctrl+right'), key('return')], [note, key('tab'), key('down'), key('return')]])
      expect(finalOf('screen_act', args, undefined, plans)?.kind, JSON.stringify(plans)).toBe('final-unknown')
    // Review (Round 5): up or down in a search field or a combo box picks a hidden suggestion (Spotlight, a command palette, an address
    // bar) and Return runs it; alt+cmd+arrow switches tabs. Both still ask. Left, right, home and end stay in any field.
    const search = { verb: 'keyboard', app: 'Obsidian', thing: { role: 'search field', name: 'Search' } }
    const combo = { verb: 'focus', app: 'Obsidian', thing: { role: 'combo box', name: 'Go to' } }
    for (const plans of [[search, key('down'), key('return')], [combo, key('down'), key('return')], [combo, key('page-down'), key('return')], [key('cmd+l'), { verb: 'type', app: 'Obsidian', thing: { name: '' }, command: { action: 'type', value: 'x' } }, key('down'), key('return')], [note, key('alt+cmd+right'), key('return')], [note, key('cmd+alt+left'), key('return')], [{ ...note, thing: { role: 'text field', name: 'Title' } }, key('down'), key('return')], [note, { verb: 'type', app: 'Obsidian', thing: { role: 'search field', name: 'Find' }, command: { action: 'type', value: 'x' } }, key('down'), key('return')]])
      expect(finalOf('screen_act', args, undefined, plans)?.kind, JSON.stringify(plans)).toBe('final-unknown')
    for (const plans of [[search, key('left'), key('end'), key('return')], [combo, key('shift+cmd+right'), key('return')], [note, key('alt+shift+down'), key('return')]])
      expect(finalOf('screen_act', args, undefined, plans), JSON.stringify(plans)).toBeNull()
  })

  it('a click on a field or a text area puts the keyboard in it, as a focus does (run 212 T19)', () => {
    const key = (value) => ({ verb: 'key', app: 'TextEdit', thing: { name: '' }, command: { action: 'key', value } })
    const args = { app: 'TextEdit', steps: [{ action: 'key', value: 'cmd+down' }, { action: 'key', value: 'return' }] }
    // Run 212: click the note's text, cmd+down, Return, type, cmd+s asked as a Return on a part nobody read; the rig said no.
    const body = { verb: 'click', app: 'TextEdit', thing: { role: 'text area', name: 'e1' } }
    const typed = { verb: 'type', app: 'TextEdit', thing: { name: '' }, command: { action: 'type', value: 'Kestrel' } }
    for (const plans of [[body, key('cmd+down'), key('return'), typed, key('cmd+s')], [{ ...body, verb: 'press', thing: { role: 'text field', name: 'Name' } }, key('end'), key('return')]])
      expect(finalOf('screen_act', args, undefined, plans), JSON.stringify(plans)).toBeNull()
    // A click on a pop-up, a button or a row still leaves the keyboard unread: an arrow and Return there ask (run 213 T22).
    for (const role of ['pop up button', 'button', 'row', 'combo box'])
      expect(finalOf('screen_act', args, undefined, [{ ...body, thing: { role, name: 'Size' } }, key('down'), key('return')])?.kind, role).toBe('final-unknown')
  })

  it('Return on a Finder row starts a rename, not a press; a delete key on it is still a delete (Round 4 bench)', () => {
    const key = (value) => ({ verb: 'key', app: 'Finder', thing: { name: '' }, command: { action: 'key', value } })
    const args = { app: 'Finder', action: 'key', value: 'return' }
    for (const role of ['row', 'outline row', 'AXOutlineRow', 'cell', 'icon'])
      for (const verb of ['select', 'keyboard'])
        expect(finalOf('screen_act', args, undefined, [{ verb, app: 'Finder', thing: { role, name: 'Delete me later.txt' } }, key('return')]), `${verb} ${role}`).toBeNull()
    const row = { verb: 'select', app: 'Finder', thing: { role: 'row', name: 'notes.txt' } }
    expect(finalOf('screen_act', { app: 'Finder', steps: [{ action: 'key', value: 'cmd+backspace' }] }, undefined, [row, key('cmd+backspace')])).toMatchObject({ kind: 'delete', app: 'Finder' })
    // Narrow: a button in Finder, or a row in another app, presses as before; an arrow off the row still asks.
    expect(finalOf('screen_act', args, undefined, [{ verb: 'focus', app: 'Finder', thing: { role: 'button', name: 'Delete' } }, key('return')])?.kind).toBe('delete')
    expect(finalOf('screen_act', { app: 'Zen', action: 'key', value: 'return' }, undefined, [{ verb: 'select', app: 'Zen', thing: { role: 'row', name: 'Delete account' } }, { ...key('return'), app: 'Zen' }])?.kind).toBe('delete')
    expect(finalOf('screen_act', args, undefined, [row, key('down'), key('return')])?.kind).toBe('final-unknown')
  })

  it('cmd+shift+g in Finder opens Go to Folder with the keyboard in its field: the path and Return go there (runs 191, 193)', () => {
    const key = (value) => ({ verb: 'key', app: 'Finder', thing: { name: '' }, command: { action: 'key', value } })
    const type = { verb: 'type', app: 'Finder', thing: { name: '' }, command: { action: 'type', value: '/tmp/gnomon-run170/Testbox-correct' } }
    const wait = { verb: 'wait', app: 'Finder', thing: { name: '1 s' } }
    for (const plans of [[key('cmd+shift+g'), type, key('return')], [key('shift+cmd+g'), wait, key('cmd+a'), type, key('return')]])
      expect(finalOf('screen_act', { app: 'Finder', action: 'key', value: 'return' }, undefined, plans), JSON.stringify(plans)).toBeNull()
    expect(finalOf('screen_act', { app: 'Finder', steps: [{ action: 'key', value: 'cmd+shift+g' }, { action: 'type', value: '/tmp/gnomon-run170' }, { action: 'key', value: 'return' }] })).toBeNull()
    // Only in Finder, and a key that moves the keyboard after it still asks.
    expect(finalOf('screen_act', { app: 'Zen', steps: [{ action: 'key', value: 'cmd+shift+g' }, { action: 'type', value: 'x' }, { action: 'key', value: 'return' }] })?.kind).toBe('final-unknown')
    expect(finalOf('screen_act', { app: 'Finder', action: 'key', value: 'return' }, undefined, [key('cmd+shift+g'), key('tab'), key('return')])?.kind).toBe('final-unknown')
  })

  it('a plain act is no final, so the test-mode switch still applies to it', () => {
    for (const args of [{ app: 'Zen', role: 'button', label: 'Next' }, { app: 'Zen', role: 'text field', label: 'Confirm password', action: 'set-value', value: 'x' }, { app: 'Zen', role: 'text field', label: 'Subject', value: 'Send me the notes' }, { app: 'TextEdit', action: 'key', value: 'cmd+s' }]) {
      expect(finalOf('screen_act', args)).toBeNull()
      expect(decide('screen_act', args, { preset: 'danger-full-access', testMode: true })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/always asks/) })
    }
    expect(finalOf('web_act', web(7), webElement)).toBeNull()
    expect(decide('web_act', web(8), { preset: 'danger-full-access', webElement }).kind).toBe('allow')
    expect(decide('gnomon_run_shell', { command: 'git rm --cached notes.txt' }, { preset: 'danger-full-access' }).kind).toBe('allow')
    expect(decide('gnomon_run_shell', { command: 'ls /tmp/gnomon-140' }, { preset: 'danger-full-access' }).kind).toBe('allow')
  })

  it('text typed into a field is not a press (review 2026-11-15): a set-value by ref types its value', () => {
    const typed = { app: 'Zen', ref: 'e4@ab12', action: 'set-value', value: 'Delete the old ones' }
    expect(finalOf('screen_act', typed)).toBeNull()
    expect(finalOf('screen_act', typed, undefined, [{ verb: 'set-value', app: 'Zen', thing: { role: 'text area', name: 'Note' }, command: { value: 'Delete the old ones' } }])).toBeNull()
    expect(finalOf('screen_act', { app: 'Zen', action: 'type', value: 'Pay the invoice on Monday' })).toBeNull()
  })

  it('an rm inside quoted text is an argument; a real rm, or one a shell runs from a string, still asks (review 2026-11-15)', () => {
    for (const command of ['echo "rm the old file later"', `git commit -m "rm unused notes"`, `printf '%s\\n' 'remember: rm a.log'`]) {
      expect(finalOf('gnomon_run_shell', { command }), command).toBeNull()
      expect(decide('gnomon_run_shell', { command }, { preset: 'danger-full-access' }).kind).toBe('allow')
    }
    for (const command of ['rm "/tmp/gnomon-140/a b.log"', `sh -c 'rm /tmp/gnomon-140/a.log'`, `osascript -e 'do shell script "rm /tmp/gnomon-140/a.log"'`]) {
      expect(finalOf('gnomon_run_shell', { command })?.kind, command).toBe('delete')
      expect(decide('gnomon_run_shell', { command }, { preset: 'danger-full-access' }).kind).toBe('ask')
    }
  })

  it('where nobody can be asked (approvals never), a final is refused, test mode too', () => {
    for (const testMode of [false, true]) {
      expect(decide('screen_act', { app: 'Finder', action: 'pick-menu', value: 'Move to Trash' }, { preset: 'danger-full-access', approvalOverride: 'never', testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/deletes.*approvals are off/) })
      expect(decide('gnomon_run_shell', { command: 'rm /tmp/gnomon-140/a.log' }, { preset: 'danger-full-access', approvalOverride: 'never', testMode }).kind).toBe('deny')
    }
  })
})

describe('a blind or unnamed final is refused in every mode', () => {
  it('a final in a private app, or with no app named, is refused, and the reason names no app', () => {
    for (const preset of PRESETS)
      for (const testMode of [false, true]) {
        const blind = decide('screen_act', { app: 'Mail', role: 'button', label: 'Delete' }, { preset, testMode })
        expect(blind).toMatchObject({ kind: 'deny' })
        expect(blind.reason).not.toMatch(/mail/i)
        expect(decide('screen_act', { app: 'Signal', role: 'button', label: 'Discard' }, { preset, testMode }).kind).toBe('deny')
        expect(decide('screen_act', { role: 'button', label: 'Pay' }, { preset, testMode }).kind).toBe('deny')
      }
    expect(decide('screen_act', { app: 'Mail', role: 'button', label: 'Delete' }, { preset: 'danger-full-access' }).reason).toMatch(/blind final step/)
    expect(decide('screen_act', { role: 'button', label: 'Pay' }, { preset: 'danger-full-access' }).reason).toMatch(/final step with no app named/)
  })

  it('a script send from a private app (Messages, Mail) is a blind send, refused in every preset and mode (review 2026-11-15)', () => {
    const MESSAGES = `osascript -e 'tell application "Messages" to send "hi" to buddy "+31600000000"'`
    const JXA = `osascript -l JavaScript -e 'Application("Messages").send("hi", {to: Application("Messages").buddies[0]})'`
    for (const command of [MESSAGES, JXA, MAIL.replace('Microsoft Outlook', 'Mail')]) {
      expect(finalOf('gnomon_run_shell', { command }), command).toMatchObject({ kind: 'send', blind: true })
      for (const preset of PRESETS)
        for (const testMode of [false, true])
          for (const toolName of ['gnomon_run_shell', 'bash']) {
            const decision = decide(toolName, { command }, { preset, testMode })
            expect(decision.kind, `${toolName} ${preset} ${testMode}`).toBe('deny')
            expect(decision.reason).not.toMatch(/Messages|\bMail\b/)
          }
    }
    // A mail app that is not private still asks as a send.
    expect(decide('gnomon_run_shell', { command: MAIL }, { preset: 'danger-full-access' })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail/) })
  })
})

// The rig's yes-clicker parses this: the gate's sentence naming the kind, the step line as screen-tools writes it
// (`Verb "thing" in App[: value]`, joined by `; then `), then behind ` · ` To, Path, Command and `final: <kind>`.
describe('the ask names the kind and the target, in the one format the rig parses', () => {
  const look = { elements: [{ role: 'AXTextField', label: 'To', value: 'test@example.com' }, { role: 'AXButton', label: 'Cc', in: 'Cc' }, { role: 'AXButton', label: 'mira@example.com', in: 'Cc' }, { role: 'AXTextField', label: 'Subject', value: 'Rig 140 from ops@example.com' }] }
  const send = { app: 'Zen', role: 'button', label: 'Send' }

  it('a screen send: the steps, then the recipients the look shows in To and Cc (and the step sets), then the tag', () => {
    expect(recipientsOf(look)).toEqual(['test@example.com', 'mira@example.com'])
    expect(finalAsk(finalOf('screen_act', send, undefined, [], recipientsOf(look)), { line: 'Press "Send" in Zen' })).toBe('Gnomon: this sends a mail or a message with "Send" in Zen, which cannot be taken back, so it asks you first. Press "Send" in Zen · To: test@example.com, mira@example.com · final: send')
    expect(finalAsk(finalOf('screen_act', { app: 'Zen', steps: [{ role: 'text field', label: 'To', action: 'set-value', value: 'test@example.com' }, send] }), { line: 'Set "To" in Zen: "test@example.com"; then press "Send" in Zen' })).toBe('Gnomon: this sends a mail or a message with "Send" in Zen, which cannot be taken back, so it asks you first. Set "To" in Zen: "test@example.com"; then press "Send" in Zen · To: test@example.com · final: send')
    expect(finalAsk(finalOf('screen_act', send), { line: 'Press "Send" in Zen' })).toMatch(/ · To: not readable on screen · final: send$/)
  })

  it('every shell ask shows its command, cut to 200 characters (index.js adds it to a plain shell ask behind " · ")', () => {
    expect(commandLine('ls /tmp/gnomon-140')).toBe('Command: ls /tmp/gnomon-140')
    expect(commandLine(`echo ${'x'.repeat(300)}`)).toBe(`Command: echo ${'x'.repeat(195)}…`)
  })

  it('a shell send carries its mail fields and its command', () => {
    expect(finalAsk(finalOf('gnomon_run_shell', { command: MAIL }), { command: MAIL })).toBe(`Gnomon: this sends a mail or a message from the shell, which cannot be taken back, so it asks you first. · To: test@example.com · Subject: "Hi" · Body: "kestrel 4821" · Command: ${MAIL.slice(0, 200)}… · final: send`)
  })

  it('a press names its control and app; a delete or discard its absolute path; a shell delete its command', () => {
    expect(finalAsk(finalOf('screen_act', { app: 'Zen', role: 'button', label: 'Place order' }), { line: 'Press "Place order" in Zen' })).toBe('Gnomon: this submits a form with "Place order" in Zen, which cannot be taken back, so it asks you first. Press "Place order" in Zen · final: submit')
    expect(finalAsk(finalOf('screen_act', { app: 'Finder', action: 'pick-menu', value: 'Move to Trash' }), { line: 'Pick "Move to Trash" in Finder', path: '/tmp/gnomon-140/old' })).toBe('Gnomon: this moves the selected items to the Trash in Finder, which cannot be taken back, so it asks you first. Pick "Move to Trash" in Finder · Path: /tmp/gnomon-140/old · final: delete')
    expect(finalAsk(finalOf('screen_act', { app: 'TextEdit', role: 'button', label: "Don't Save" }), { line: `Press "Don't Save" in TextEdit`, path: '/tmp/gnomon-140/memo.txt' })).toBe(`Gnomon: this discards unsaved changes with "Don't Save" in TextEdit, which cannot be taken back, so it asks you first. Press "Don't Save" in TextEdit · Path: /tmp/gnomon-140/memo.txt · final: discard`)
    expect(finalAsk(finalOf('gnomon_run_shell', { command: 'rm "/tmp/gnomon-140/old/a.log" data/fix/b.log' }), { command: 'rm "/tmp/gnomon-140/old/a.log" data/fix/b.log' })).toBe('Gnomon: this deletes "/tmp/gnomon-140/old/a.log", "data/fix/b.log" from the shell, which cannot be taken back, so it asks you first. · Path: /tmp/gnomon-140/old/a.log · Touches: deletes "/tmp/gnomon-140/old/a.log", "data/fix/b.log" · Command: rm "/tmp/gnomon-140/old/a.log" data/fix/b.log · final: delete')
    for (const kind of ['pay', 'post']) expect(finalAsk({ kind, via: 'web', blind: false })).toMatch(new RegExp(`^Gnomon: this (pays|posts) .* · final: ${kind}$`))
  })

  it('the record keeps the kind, never the name, the address or the command (W3)', () => {
    const facts = callFacts({ toolName: 'screen_act', args: { app: 'Zen', steps: [{ role: 'text field', label: 'To', action: 'set-value', value: 'test@example.com' }, { role: 'button', label: 'Send' }] } })
    expect(facts.final).toEqual({ kind: 'send', via: 'screen', blind: false })
    expect(JSON.stringify(facts)).not.toMatch(/example\.com|Zen/)
    expect(callFacts({ toolName: 'bash', args: { command: 'rm /tmp/gnomon-140/a.log' } }).final).toEqual({ kind: 'delete', via: 'shell', blind: false })
    expect(decide('gnomon_run_shell', { command: 'rm /tmp/gnomon-140/a.log' }).reason).not.toMatch(/gnomon-140/)
  })
})

describe('a private app is never opened or raised (2026-11-14)', () => {
  afterEach(() => applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] }))
  const refused = (toolName, args, over = {}) => {
    for (const preset of PRESETS)
      for (const testMode of [false, true]) {
        const decision = decide(toolName, args, { preset, testMode, ...over })
        expect(decision.kind, `${toolName} ${JSON.stringify(args)} ${preset} ${testMode}`).toBe('deny')
        if (preset !== 'read-only') expect(decision.reason).toMatch(/private app/)
        expect(decision.reason).not.toMatch(/signal|puzzlebox/i)
      }
  }

  it('a built-in private app: open, raise, a key, a press, and a shell open or activate', () => {
    for (const args of [{ app: 'Signal' }, { app: 'Signal', action: 'open' }, { app: 'Signal', window: 'Chats', action: 'raise' }, { app: 'Signal', action: 'key', value: 'cmd+n' }, { app: 'Signal', role: 'button', label: 'Settings' }, { target: { app: 'Signal' }, action: 'raise' }]) refused('screen_act', args)
    for (const command of ['open -a Signal', 'open -a "Signal"', 'open -b org.whispersystems.signal-desktop', 'open /Applications/Signal.app', `osascript -e 'tell application "Signal" to activate'`]) {
      refused('gnomon_run_shell', { command })
      refused('bash', { command })
    }
  })

  it("an app on the owner's own list is refused the same way", () => {
    expect(decide('screen_act', { app: 'Puzzlebox Notes' }, { preset: 'danger-full-access' }).kind).toBe('ask')
    expect(decide('gnomon_run_shell', { command: 'open -a "Puzzlebox Notes"' }, { preset: 'danger-full-access' }).kind).toBe('allow')
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: ['puzzlebox'], extraShellRedactPatterns: [] })
    refused('screen_act', { app: 'Puzzlebox Notes' })
    refused('screen_act', { app: 'Puzzlebox Notes', action: 'raise' })
    refused('gnomon_run_shell', { command: 'open -a "Puzzlebox Notes"' })
  })

  it('a URL scheme or a bundle id that opens a private app is refused, by the shell and by a screen url step (review 2026-11-15)', () => {
    for (const command of ['open messages://', 'open facetime://+31600000000', 'open sms:+31600000000', 'open "imessage:test@example.com"', 'open tel:+31600000000', 'open whatsapp://send?text=hi', 'open tg://resolve?domain=x', 'open signal://', 'open -b com.apple.MobileSMS', `osascript -e 'open location "sms:+31600000000"'`, `osascript -e 'tell application id "com.apple.MobileSMS" to activate'`]) refused('gnomon_run_shell', { command })
    for (const url of ['sms:+31600000000', 'imessage://test@example.com', 'whatsapp://send', 'tel:+31600000000']) refused('screen_act', { app: 'Zen', url })
    refused('screen_act', { app: 'com.apple.MobileSMS' })
    expect(decide('gnomon_run_shell', { command: 'open https://example.com/tel:1' }, { preset: 'danger-full-access' }).kind).toBe('allow')
    expect(decide('screen_act', { app: 'Zen', url: 'https://example.com' }, { preset: 'danger-full-access' }).kind).toBe('ask')
  })

  it("a shell command that names a private app's data is refused in every preset (review 2026-11-15)", () => {
    for (const command of ['sqlite3 ~/Library/Messages/chat.db "select count(*) from message"', 'ls ~/Library/Messages', 'cp chat.db /tmp/gnomon-140/', 'ls -la ~/Library/Mail/V10', 'cat "$HOME/Library/Application Support/Signal/config.json"', 'ls ~/Library/Application\\ Support/Slack', 'find ~/Library/Containers/com.apple.mail -name "*.emlx"', 'ls ~/Library/Group\\ Containers/group.net.whatsapp.WhatsApp.shared']) {
      refused('gnomon_run_shell', { command })
      refused('bash', { command })
    }
    for (const command of ['ls ~/Library/Application\\ Support/Code/User', 'ls ~/Library/Caches', 'cat /tmp/gnomon-140/mail-notes.txt']) expect(decide('gnomon_run_shell', { command }, { preset: 'danger-full-access' }).kind, command).toBe('allow')
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: ['puzzlebox'], extraShellRedactPatterns: [] })
    refused('gnomon_run_shell', { command: 'ls ~/Library/Application\\ Support/Puzzlebox' })
  })

  it('an app that is not private still opens, and a mail app that is not private still asks as a send', () => {
    expect(decide('screen_act', { app: 'TextEdit' }, { preset: 'danger-full-access' }).kind).toBe('ask')
    expect(decide('gnomon_run_shell', { command: 'open -a TextEdit /tmp/gnomon-140/memo.txt' }, { preset: 'danger-full-access' }).kind).toBe('allow')
    expect(decide('gnomon_run_shell', { command: MAIL }, { preset: 'danger-full-access' })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail/) })
    // A ref step acts in the app of the last look: in a private one, that is a private act.
    expect(callFacts({ toolName: 'screen_act', args: { ref: 'e1@aa11', action: 'press' }, lookApp: 'Signal' }).private).toBe(true)
  })
})

describe('an update prompt (Set 2 R4): its go asks, its later is plain', () => {
  it('Update, Install, Restart Now and Upgrade name the update kind in the ask; Later, Not Now, Remind Me Later and Skip are no final', () => {
    const update = finalOf('screen_act', { app: 'Zen', role: 'button', label: 'Install Update' })
    expect(finalAsk(update, { window: 'Software Update' }).split(' · ')).toEqual(expect.arrayContaining([expect.stringMatching(/installs an update or restarts with "Install Update" in Zen/), 'final: update']))
    for (const label of ['Later', 'Not Now', 'Remind Me Later', 'Skip', 'Skip This Version', 'Restart Later', 'Check for Updates…']) {
      expect(finalOf('screen_act', { app: 'Zen', role: 'button', label }), label).toBeNull()
      expect(decide('screen_act', { app: 'Zen', role: 'button', label }, { preset: 'danger-full-access', testMode: true }).reason ?? '', label).not.toMatch(/cannot be taken back/)
    }
    expect(finalOf('web_act', web(10), webElement)).toBeNull()
    // A field labelled so is a field, not a press.
    expect(finalOf('screen_act', { app: 'Zen', role: 'AXTextField', label: 'Update note', action: 'set-value', value: 'x' })).toBeNull()
  })
})

describe('Return on a ref is a press on that thing (run 234 T25: key return on the Send ref sent unasked)', () => {
  const CHROME = 'Google Chrome for Testing'
  const el = (ref, role, label) => ({ ref, role, sub: '', screenText: [label, '', 'Testbox'], frame: [10, 10 * Number(ref.slice(1)), 200, 20], actions: role === 'AXButton' ? ['AXPress'] : [], settable: role !== 'AXButton', enabled: true })
  /** The Testbox page as run 234 looked at it, the keyboard in the Message text area after the typing. */
  const row = { id: 'look-r234', tag: 'eb32b6', processName: CHROME, windowTitle: 'Testbox - Google Chrome for Testing', focused: 'e29', elements: [el('e24', 'AXTextField', 'To'), el('e27', 'AXTextField', 'Subject'), el('e29', 'AXTextArea', 'Message'), el('e30', 'AXButton', ''), el('e31', 'AXButton', 'Send')] }
  const readLook = async (id, { field = 'id' } = {}) => (row[field === 'tag' ? 'tag' : 'id'] === id ? row : null)
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: row.id, app: CHROME, n: 5 } } }
  /** As index.js judges a call: screen-tools' plans, then the keyboard and the form the look shows (judgedPlans). */
  const judged = async (args) => {
    const plan = await screenAsk('screen_act', args, state, readLook, null, [], 'rig-234')
    expect(plan.error, JSON.stringify(args)).toBeUndefined()
    return judgedPlans(plan.plans ?? [plan], lookOf(row))
  }
  const asksAsSend = async (args, on = 'Send') => {
    const plans = await judged(args)
    expect(finalOf('screen_act', args, undefined, plans), JSON.stringify(args)).toMatchObject({ kind: 'send', via: 'screen', app: CHROME, on })
    for (const preset of PRESETS)
      for (const testMode of [false, true])
        // A ref step types in the app of the last look (index.js lookApp).
        expect(decideAction({ toolName: 'screen_act', args: freeze(args), preset, actions, resolveActionPolicy, testMode, facts: callFacts({ toolName: 'screen_act', args, plans, lookApp: CHROME }) }), `${preset} ${testMode}`).toMatchObject(preset === 'read-only' ? { kind: 'deny' } : { kind: 'ask', reason: expect.stringMatching(/^Gnomon: this sends a mail or a message/) })
    return plans
  }

  it('the exact call: key return with a ref to the Send button, the keyboard elsewhere; Enter, keypad enter and space alike', async () => {
    const call = { action: 'key', value: 'return', ref: 'e31@eb32b6', goal: 'send the mail' }
    const plans = await asksAsSend(call)
    expect(finalAsk(finalOf('screen_act', call, undefined, plans), { line: 'Key "Send" in Google Chrome for Testing: return' })).toMatch(/^Gnomon: this sends a mail or a message with return on "Send" in Google Chrome for Testing \(window "Testbox - Google Chrome for Testing"\), which cannot be taken back/)
    for (const value of ['enter', 'kp_enter', 'space', 'Return']) await asksAsSend({ ...call, value })
    // The same key on Send by its role and words, not a ref.
    await asksAsSend({ app: CHROME, role: 'button', label: 'Send', action: 'key', value: 'return' })
  })

  it('a chain step: type, then key return on the Send ref', async () => {
    await asksAsSend({ app: CHROME, goal: 'send the mail', steps: [{ ref: 'e29@eb32b6', action: 'focus' }, { action: 'type', value: 'kettle count 4821' }, { action: 'key', value: 'return', ref: 'e31@eb32b6' }] })
  })

  it('fail closed: a Return ref the gate cannot read is a final-unknown, with no plan or on a button with no words', async () => {
    const call = { app: CHROME, action: 'key', value: 'return', ref: 'e31@eb32b6' }
    expect(finalOf('screen_act', call)).toMatchObject({ kind: 'final-unknown', why: 'what it lands on shows no words' })
    expect(finalOf('screen_act', { app: CHROME, steps: [{ action: 'type', value: 'x' }, call] })?.kind).toBe('final-unknown')
    const blank = await judged({ ...call, ref: 'e30@eb32b6' })
    expect(finalAsk(finalOf('screen_act', { ...call, ref: 'e30@eb32b6' }, undefined, blank))).toMatch(/^Gnomon: this Return in Google Chrome for Testing \(window "Testbox - Google Chrome for Testing"\) lands on a part Gnomon cannot read for certain \(what it lands on shows no words\)/)
  })

  it('Return in a one-line field of a web form with a Send button sends; a text area, a search or a native app does not', async () => {
    await asksAsSend({ app: CHROME, action: 'key', value: 'return', ref: 'e27@eb32b6' }, 'Subject')
    await asksAsSend({ app: CHROME, steps: [{ ref: 'e27@eb32b6', action: 'focus' }, { action: 'type', value: 'Crates' }, { action: 'key', value: 'return' }] }, 'Subject')
    // Return in the Message text area adds a line; the keyboard look alone puts it there.
    expect(finalOf('screen_act', { app: CHROME, action: 'key', value: 'return' }, undefined, await judged({ app: CHROME, action: 'key', value: 'return' }))).toBeNull()
    const field = (role, name, app = CHROME) => [{ verb: 'focus', app, thing: { role, name } }, { verb: 'key', app, thing: { name: '' }, command: { action: 'key', value: 'return' }, form: 'Send' }]
    for (const plans of [field('search field', 'Search'), field('text field', 'Address and search bar'), field('text area', 'Message')]) expect(finalOf('screen_act', { app: CHROME, action: 'key', value: 'return' }, undefined, plans), JSON.stringify(plans)).toBeNull()
    expect(judgedPlans([{ verb: 'key', app: 'Mail', command: { value: 'return' } }], { ...lookOf(row), app: 'Mail' }).some((p) => p.form)).toBe(false)
  })

  it('a route replay step: a learned focus on Subject, then Return, is that Send', async () => {
    const rows = ['s1', 's22', 's333'].flatMap((session) => [
      { at: `2026-11-1${session.length}T09:00:00Z`, session, goal: 'send the mail', processName: CHROME, verb: 'focus', role: 'text field', screenText: ['Subject'], ok: true, changed: true },
      { at: `2026-11-1${session.length}T09:00:01Z`, session, goal: 'send the mail', processName: CHROME, verb: 'key', key: 'return', screenText: [''], ok: true, changed: true },
    ])
    const route = routeReplay({ judge: async () => null, readSteps: async () => rows, readWorks: async () => [] })
    const args = { app: CHROME, goal: 'send the mail', route: true }
    const asked = await screenAsk('screen_act', args, state, readLook, route, [], 'own')
    expect(asked.replay).toEqual([{ action: 'focus', role: 'text field', label: 'Subject' }, { action: 'key', value: 'return' }])
    const plans = judgedPlans(asked.plans, lookOf(row))
    expect(finalOf('screen_act', { ...args, steps: asked.replay }, undefined, plans)).toMatchObject({ kind: 'send', app: CHROME, on: 'Subject' })
    expect(decideAction({ toolName: 'screen_act', args, preset: 'danger-full-access', actions, resolveActionPolicy, testMode: true, facts: callFacts({ toolName: 'screen_act', args: { ...args, steps: asked.replay }, plans, lookApp: CHROME }) })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail or a message/) })
  })

  it('S5R1 gap 3: a learned key on the Send button replays on Send, not where the keyboard is, and asks', async () => {
    const rows = ['s1', 's22', 's333'].flatMap((session) => [
      { at: `2026-11-1${session.length}T09:00:00Z`, session, goal: 'finish the mail', processName: CHROME, verb: 'focus', role: 'text area', screenText: ['Message'], ok: true, changed: true },
      { at: `2026-11-1${session.length}T09:00:01Z`, session, goal: 'finish the mail', processName: CHROME, verb: 'key', role: 'button', key: 'return', screenText: ['Send'], ok: true, changed: true },
    ])
    const route = routeReplay({ judge: async () => null, readSteps: async () => rows, readWorks: async () => [] })
    const args = { app: CHROME, goal: 'finish the mail', route: true }
    const asked = await screenAsk('screen_act', args, state, readLook, route, [], 'own')
    expect(asked.replay).toEqual([{ action: 'focus', role: 'text area', label: 'Message' }, { action: 'key', value: 'return', role: 'button', label: 'Send' }])
    const plans = judgedPlans(asked.plans, lookOf(row))
    expect(finalOf('screen_act', { ...args, steps: asked.replay }, undefined, plans)).toMatchObject({ kind: 'send', app: CHROME, on: 'Send' })
    expect(decideAction({ toolName: 'screen_act', args, preset: 'danger-full-access', actions, resolveActionPolicy, testMode: true, facts: callFacts({ toolName: 'screen_act', args: { ...args, steps: asked.replay }, plans, lookApp: CHROME }) })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/sends a mail or a message/) })
    expect(finalAsk(finalOf('screen_act', { ...args, steps: asked.replay }, undefined, plans))).toMatch(/^Gnomon: this sends a mail or a message with return on "Send" in Google Chrome for Testing/)
  })
})

describe('Return in a chat message box sends (S5R1: a composer Return was read as a new line, and ran unasked)', () => {
  const CHROME = 'Google Chrome'
  const el = (ref, role, label, frame, within) => ({ ref, role, sub: role === 'AXTextField' && /search/i.test(label) ? 'AXSearchField' : '', screenText: [label, '', within], frame, actions: role === 'AXButton' ? ['AXPress'] : [], settable: role !== 'AXButton', enabled: true })
  /** A native chat-like app no list names: the box shows its Send beside it. */
  const QUILL = { id: 'look-quill', tag: 'a1b2c3', processName: 'Quill', bundleId: 'dev.example.quill', windowTitle: 'kettle-room', focused: 'e5', elements: [el('e1', 'AXTextField', 'Search Quill', [300, 10, 400, 24], 'toolbar'), el('e2', 'AXRow', 'kettle-room', [0, 100, 200, 24], 'sidebar'), el('e5', 'AXTextArea', 'Message #kettle-room', [300, 700, 600, 40], 'composer'), el('e6', 'AXButton', 'Send', [910, 705, 30, 30], 'composer')] }
  /** A chat in a browser tab: the page names it, the box has no Send beside it (it shows once something is typed). */
  const SLACK_WEB = { id: 'look-slackweb', tag: 'd4e5f6', processName: CHROME, windowTitle: 'kettle-room (Channel) - Puzzlebox - Slack', focused: 'e9', elements: [el('e3', 'AXWebArea', 'kettle-room (Channel) - Puzzlebox - Slack', [0, 80, 1200, 800], ''), el('e4', 'AXTextField', 'Search Puzzlebox', [400, 90, 400, 24], 'Slack'), el('e9', 'AXTextArea', 'Message Mira Bakker', [220, 800, 900, 40], 'Slack'), el('e10', 'AXButton', 'Formatting', [220, 700, 30, 30], 'Slack')] }
  /** A web page no list names: a comment box with its Comment button. */
  const BOARD = { id: 'look-board', tag: 'a7b8c9', processName: CHROME, windowTitle: 'BOX-484 - Lantern board', focused: 'e7', elements: [el('e7', 'AXTextArea', 'Add a comment', [100, 500, 600, 80], 'Activity'), el('e8', 'AXButton', 'Comment', [100, 590, 80, 24], 'Activity')] }
  /** A code editor's own chat box with a Send button: Return there is not judged a send. */
  const EDITOR = { id: 'look-editor', tag: 'c0d1e2', processName: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', windowTitle: 'gate.js', focused: 'e2', elements: [el('e2', 'AXTextArea', 'Chat input', [10, 700, 300, 40], 'Chat'), el('e3', 'AXButton', 'Send', [320, 705, 30, 30], 'Chat')] }
  /** A native sheet: a one-line field, and the default button its Return presses (Sundial.app marks it `default`). */
  const sheet = (id, label) => ({ id, tag: `${id.slice(-4)}ab`, processName: 'Lantern', windowTitle: 'Share BOX-484', dialog: true, focused: 'e1', defaultButton: { ref: 'e3', label }, elements: [el('e1', 'AXTextField', 'Note to Mira', [100, 100, 300, 22], 'sheet'), el('e2', 'AXButton', 'Cancel', [200, 200, 60, 24], 'sheet'), { ...el('e3', 'AXButton', label, [280, 200, 60, 24], 'sheet'), default: true }] })
  const [SHEET_SEND, SHEET_OK, SHEET_BLANK] = [sheet('look-sheet-send', 'Send'), sheet('look-sheet-ok', 'OK'), sheet('look-sheet-blank', '')]
  /** A web page's one-line field: a `default` part there is the page's, never what Return presses; its form is read as before. */
  const WEB_FIELD = { id: 'look-webfield', tag: 'f1f2f3', processName: CHROME, windowTitle: 'Lantern sign-up', focused: 'e2', elements: [el('e1', 'AXWebArea', 'Lantern sign-up', [0, 80, 1200, 800], ''), el('e2', 'AXTextField', 'Name', [100, 200, 300, 22], 'Lantern sign-up'), { ...el('e3', 'AXButton', '', [100, 240, 60, 24], 'Lantern sign-up'), default: true }] }
  const rows = [QUILL, SLACK_WEB, BOARD, EDITOR, SHEET_SEND, SHEET_OK, SHEET_BLANK, WEB_FIELD]
  const readLook = async (id, { field = 'id' } = {}) => rows.find((r) => r[field === 'tag' ? 'tag' : 'id'] === id) ?? null
  /** As index.js judges a call: screen-tools' plans, then the keyboard, the form and the box the app's last look shows. */
  const judged = async (args, row) => {
    const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: row.id, app: row.processName, n: row.elements.length } } }
    const plan = await screenAsk('screen_act', args, state, readLook, null, [], 's5r1')
    expect(plan.error, JSON.stringify(args)).toBeUndefined()
    return judgedPlans(plan.plans ?? [plan], lookOf(row))
  }
  const asked = (args, plans, app) => {
    for (const preset of PRESETS)
      for (const testMode of [false, true])
        expect(decideAction({ toolName: 'screen_act', args: freeze(args), preset, actions, resolveActionPolicy, testMode, facts: callFacts({ toolName: 'screen_act', args, plans, lookApp: app }) }), `${preset} ${testMode}`).toMatchObject(preset === 'read-only' ? { kind: 'deny' } : { kind: 'ask' })
  }
  const sends = async (args, row, want) => {
    const plans = row ? await judged(args, row) : []
    const final = finalOf('screen_act', args, undefined, plans)
    expect(final, JSON.stringify(args)).toMatchObject({ kind: 'send', via: 'screen', ...want })
    asked(args, plans, want.app)
    return final
  }

  it('a native app whose box shows Send beside it: Return, Enter, keypad enter, cmd+Return and ctrl+Return send, naming the app and the conversation', async () => {
    for (const value of ['return', 'enter', 'kp_enter', 'cmd+return', 'ctrl+return']) await sends({ app: 'Quill', action: 'key', value }, QUILL, { app: 'Quill', on: 'Message #kettle-room', to: ['#kettle-room'] })
    const call = { app: 'Quill', steps: [{ ref: 'e5@a1b2c3', action: 'focus' }, { action: 'type', value: 'kettle count 4821' }, { action: 'key', value: 'return' }] }
    const final = await sends(call, QUILL, { app: 'Quill', what: 'Send', on: 'Message #kettle-room' })
    expect(finalAsk(final, { window: 'kettle-room' })).toBe('Gnomon: this sends a mail or a message with return on "Message #kettle-room" in Quill (window "kettle-room"), which cannot be taken back, so it asks you first. · To: #kettle-room · final: send')
  })

  it('a chat in a browser tab (a web look): the page names Slack, so Return in its box sends; a web comment box with its Comment button too', async () => {
    await sends({ app: CHROME, action: 'key', value: 'return' }, SLACK_WEB, { app: CHROME, on: 'Message Mira Bakker', to: ['Mira Bakker'] })
    await sends({ app: CHROME, action: 'key', value: 'cmd+enter' }, SLACK_WEB, { app: CHROME })
    await sends({ app: CHROME, action: 'key', value: 'return' }, BOARD, { app: CHROME, what: 'Comment', on: 'Add a comment' })
  })

  it('Shift+Return adds a line: never a final, in the box, in a chat app with no look, or between typing', async () => {
    for (const value of ['shift+return', 'shift+enter', 'Shift + Return']) {
      expect(finalOf('screen_act', { app: 'Quill', action: 'key', value }, undefined, await judged({ app: 'Quill', action: 'key', value }, QUILL))).toBeNull()
      expect(finalOf('screen_act', { app: 'Slack', action: 'key', value })).toBeNull()
      expect(finalOf('screen_act', { app: CHROME, action: 'key', value }, undefined, await judged({ app: CHROME, action: 'key', value }, SLACK_WEB))).toBeNull()
    }
    // A new line inside the box keeps the keyboard there: the Return after it still sends, from that box.
    await sends({ app: 'Quill', steps: [{ ref: 'e5@a1b2c3', action: 'focus' }, { action: 'type', value: 'line one' }, { action: 'key', value: 'shift+return' }, { action: 'type', value: 'line two' }, { action: 'key', value: 'return' }] }, QUILL, { app: 'Quill', on: 'Message #kettle-room' })
  })

  it('a code editor, a terminal, a text editor, a search box and an address bar: Return is not a send', async () => {
    expect(finalOf('screen_act', { app: 'Visual Studio Code', action: 'key', value: 'return' }, undefined, await judged({ app: 'Visual Studio Code', action: 'key', value: 'return' }, EDITOR))).toBeNull()
    for (const app of ['Terminal', 'iTerm2', 'TextEdit', 'Xcode', 'Cursor']) {
      const plans = [{ verb: 'keyboard', app, thing: { role: 'text area', name: 'Editor' } }, { verb: 'key', app, thing: { name: '' }, command: { value: 'return' } }]
      expect(finalOf('screen_act', { app, action: 'key', value: 'return' }, undefined, plans), app).toBeNull()
    }
    // Return in a chat app's search runs the search; in a browser's address bar it opens a page.
    const search = { app: 'Quill', action: 'key', value: 'return', ref: 'e1@a1b2c3' }
    expect(finalOf('screen_act', search, undefined, await judged(search, QUILL))).toBeNull()
    expect(finalOf('screen_act', { app: 'Slack', steps: [{ action: 'key', value: 'cmd+f' }, { action: 'type', value: 'kettle' }, { action: 'key', value: 'return' }] })).toBeNull()
    const bar = { app: CHROME, steps: [{ action: 'key', value: 'cmd+l' }, { action: 'type', value: 'example.org' }, { action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', bar, undefined, judgedPlans([{ verb: 'key', app: CHROME, thing: { name: '' }, command: { value: 'cmd+l' } }, { verb: 'type', app: CHROME, thing: { name: '' }, command: { value: 'example.org' } }, { verb: 'key', app: CHROME, thing: { name: '' }, command: { value: 'return' } }], lookOf(SLACK_WEB)))).toBeNull()
  })

  it('fail closed: a Return in a known chat app whose box is not readable is a final-unknown, and asks', async () => {
    // Slack and Discord are private apps by default: refused before this (deny), never run unasked.
    for (const app of ['Slack', 'Microsoft Teams', 'Discord', 'Element', 'Mattermost', 'Zulip']) {
      const call = { app, action: 'key', value: 'return' }
      expect(finalOf('screen_act', call), app).toMatchObject({ kind: 'final-unknown', app, why: expect.stringMatching(/chat/) })
      if (!['Slack', 'Discord'].includes(app)) asked(call, [], app)
    }
    // A look of the chat with nothing holding the keyboard: still unknown.
    const plans = judgedPlans([{ verb: 'key', app: CHROME, thing: { name: '' }, command: { value: 'return' } }], lookOf({ ...SLACK_WEB, focused: null }))
    expect(finalAsk(finalOf('screen_act', { app: CHROME, action: 'key', value: 'return' }, undefined, plans))).toMatch(/^Gnomon: this Return in Google Chrome lands on a part Gnomon cannot read for certain \(in a chat Return sends, and no look shows what the keyboard is in\)/)
    // cmd+Return in a chat app sends, look or none.
    expect(finalOf('screen_act', { app: 'Slack', action: 'key', value: 'cmd+return' })?.kind).toBe('send')
  })

  it('a native one-line field presses its default button: Send is a final named, OK is none, no words is a final-unknown; a web field is as before', async () => {
    for (const value of ['return', 'enter', 'kp_enter']) {
      const final = await sends({ app: 'Lantern', action: 'key', value }, SHEET_SEND, { app: 'Lantern', what: 'Send', on: 'Send' })
      expect(finalAsk(final)).toMatch(new RegExp(`^Gnomon: this sends a mail or a message with ${value} on "Send" in Lantern \\(window "Share BOX-484"\\), which cannot be taken back`))
    }
    // The same, typed first, and by the field's ref.
    await sends({ app: 'Lantern', steps: [{ ref: 'e1@sendab', action: 'focus' }, { action: 'type', value: 'see you' }, { action: 'key', value: 'return' }] }, SHEET_SEND, { on: 'Send' })
    await sends({ app: 'Lantern', action: 'key', value: 'return', ref: 'e1@sendab' }, SHEET_SEND, { on: 'Send' })
    // Space types a space; OK is no final.
    expect(finalOf('screen_act', { app: 'Lantern', action: 'key', value: 'space' }, undefined, await judged({ app: 'Lantern', action: 'key', value: 'space' }, SHEET_SEND))).toBeNull()
    expect(finalOf('screen_act', { app: 'Lantern', action: 'key', value: 'return' }, undefined, await judged({ app: 'Lantern', action: 'key', value: 'return' }, SHEET_OK))).toBeNull()
    const blank = { app: 'Lantern', action: 'key', value: 'return' }
    const plans = await judged(blank, SHEET_BLANK)
    expect(finalOf('screen_act', blank, undefined, plans)).toMatchObject({ kind: 'final-unknown', app: 'Lantern', why: 'the default button a Return presses shows no words' })
    asked(blank, plans, 'Lantern')
    expect(finalOf('screen_act', { app: CHROME, action: 'key', value: 'return' }, undefined, await judged({ app: CHROME, action: 'key', value: 'return' }, WEB_FIELD))).toBeNull()
  })
})

describe('review S5R2 M2: what the ask says of a final is the plan\'s, never a field the model put on a step', () => {
  it('a step\'s own inWindow, kind, on or why does not reach the ask', () => {
    const plans = [{ verb: 'press', app: 'Rig Browser', thing: { role: 'button', name: 'Send' }, inWindow: 'Testbox', command: {} }]
    const args = { app: 'Rig Browser', label: 'Send', action: 'press', inWindow: 'Draft to Mira Bakker', kind: 'answer', on: 'Kestrel brief', why: 'it is fine' }
    const final = finalOf('screen_act', args, undefined, plans)
    expect(final).toMatchObject({ kind: 'send', refWindow: 'Testbox' })
    expect(final.on).toBeUndefined()
    expect(final.why).toBeUndefined()
    expect(finalAsk(final, { window: 'Testbox' })).toMatch(/^Gnomon: this sends a mail or a message with "Send" in Rig Browser \(window "Testbox"\)/)
    expect(finalOf('screen_act', { steps: JSON.stringify([{ app: 'Rig Browser', label: 'Send', action: 'press', inWindow: 'Draft to Mira Bakker' }]) }, undefined, plans).refWindow).toBe('Testbox')
  })
})
