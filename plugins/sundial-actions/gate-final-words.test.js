// S5R1 final words: the classification gaps a final slipped through (destructive and outward words, a Return that reaches a
// default button off a field, web composers, thread panes, a chat's navigators, a bare Return by System Events). Every value is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, finalAsk, finalOf, judgedPlans } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, args, { preset = 'danger-full-access', testMode = true, plans } = {}) =>
  decideAction({ toolName, args, preset, actions, resolveActionPolicy, testMode, facts: callFacts({ toolName, args, plans }) })

describe('destructive and outward words are finals, named by their kind; navigation words are not', () => {
  const press = (label) => finalOf('screen_act', { app: 'Lantern', role: 'button', label })
  it('each word is a final of its kind, and asks naming that kind', () => {
    const KINDS = {
      overwrite: ['Replace', 'Overwrite', 'Replace All'],
      archive: ['Archive', 'Archive conversation'],
      leave: ['Leave', 'Leave channel', 'Leave meeting', 'Unsubscribe'],
      block: ['Block', 'Block Mira Bakker', 'Revoke', 'Revoke access'],
      share: ['Share', 'Share with 3 people', 'Invite', 'Invite to BOX-484'],
      transfer: ['Transfer', 'Transfer ownership'],
      merge: ['Merge', 'Merge pull request', 'Squash and merge', 'Rebase and merge'],
      answer: ['Approve', 'Accept', 'Accept invitation', 'Decline'],
      delete: ['Erase', 'Unsend', 'Remove', 'Empty Trash'],
      discard: ['Discard', 'Discard changes'],
      post: ['Publish'],
    }
    for (const [kind, words] of Object.entries(KINDS))
      for (const label of words) {
        expect(press(label)?.kind, label).toBe(kind)
        expect(decide('screen_act', { app: 'Lantern', role: 'button', label }), label).toMatchObject({ kind: 'ask' })
      }
    expect(finalAsk(press('Replace'))).toBe('Gnomon: this overwrites what is there with "Replace" in Lantern, which cannot be taken back, so it asks you first. · final: overwrite')
    expect(finalAsk(press('Leave channel'))).toMatch(/^Gnomon: this leaves or unsubscribes with "Leave channel"/)
    expect(decide('screen_act', { app: 'Lantern', role: 'button', label: 'Share' }).reason).toMatch(/^Gnomon: this shares with others \(Share, Invite\), which cannot be taken back/)
  })

  it('navigation and words that only open more are not finals: Forward, Shared with me, Block quote, Leave a comment, Share…, Merge All Windows', () => {
    for (const label of ['Forward', 'Back', 'Next', 'Open', 'Reply', 'OK', 'Cancel', 'Shared with me', 'Archived', 'Archives', 'Block quote', 'Blockquote', 'Leave a comment', 'Leave feedback', 'Share…', 'Share...', 'Replace…', 'Invite people…', 'Merge All Windows', 'Merge Cells', 'Accept all cookies', 'Decline cookies', 'Transfers'])
      expect(press(label), label).toBeNull()
  })

  it("a Save sheet's default Replace: Return in its name field asks as an overwrite", () => {
    const plans = [{ verb: 'keyboard', app: 'TextEdit', thing: { role: 'text field', name: 'Save As', default: 'Replace' } }, { verb: 'key', app: 'TextEdit', thing: { name: '' }, command: { value: 'return' } }]
    expect(finalOf('screen_act', { app: 'TextEdit', action: 'key', value: 'return' }, undefined, plans)).toMatchObject({ kind: 'overwrite', what: 'Replace', on: 'Replace' })
  })
})

/** A part as a look gives it (lookOf's shape), and a native sheet whose default button is `label`, the keyboard on `focused`. */
const el = (ref, role, label, frame, more = {}) => ({ ref, role, sub: '', label, value: '', frame, actions: role === 'AXButton' ? ['AXPress'] : [], settable: false, enabled: true, in: 'sheet', ...more })
const sheet = (label, focused, app = 'Lantern') => ({
  id: 'look-sheet', tag: 'ab12', app, window: 'Share BOX-484', dialog: true, focused, defaultButton: { ref: 'e9' },
  elements: [
    el('e1', 'AXCheckBox', 'Also remove the attachments', [100, 100, 200, 20]),
    el('e2', 'AXRow', 'kettle-notes.md', [100, 140, 300, 20], { in: 'files' }),
    el('e3', 'AXPopUpButton', 'Format', [100, 180, 120, 22]),
    el('e4', 'AXTextArea', 'Note to Mira', [100, 220, 300, 80], { settable: true }),
    el('e5', 'AXButton', 'Delete', [200, 320, 60, 24]),
    el('e8', 'AXButton', 'Cancel', [270, 320, 60, 24], { cancel: true }),
    el('e9', 'AXButton', label, [340, 320, 60, 24], { default: true }),
  ],
})
const ret = (app = 'Lantern', value = 'return') => [{ verb: 'key', app, thing: { name: '' }, command: { value } }]
const judge = (look, steps = ret(look.app)) => finalOf('screen_act', { app: look.app, action: 'key', value: steps.at(-1).command.value }, undefined, judgedPlans(steps, look))

describe('a Return off a text field presses the default button: a list, a checkbox, a popup, or nothing readable', () => {
  it('the keyboard on a checkbox, a row or a popup: the default button decides, by its words', () => {
    for (const focused of ['e1', 'e2', 'e3']) {
      expect(judge(sheet('Delete', focused)), focused).toMatchObject({ kind: 'delete', what: 'Delete', on: 'Delete' })
      expect(judge(sheet('Replace', focused)), focused).toMatchObject({ kind: 'overwrite', on: 'Replace' })
      expect(judge(sheet('', focused)), focused).toMatchObject({ kind: 'final-unknown', why: 'the default button a Return presses shows no words' })
      expect(judge(sheet('OK', focused)), focused).toBeNull()
    }
    const plans = judgedPlans(ret(), sheet('Send', 'e1'))
    expect(decide('screen_act', { app: 'Lantern', action: 'key', value: 'return' }, { plans })).toMatchObject({ kind: 'ask' })
  })

  it('nothing holds the keyboard (or nothing readable does): Return presses the default button', () => {
    expect(judge(sheet('Send', undefined))).toMatchObject({ kind: 'send', on: 'Send' })
    expect(judge(sheet('Send', 'e77'))).toMatchObject({ kind: 'send', on: 'Send' })
    expect(judge(sheet('OK', undefined))).toBeNull()
  })

  it('a focused button: Return presses the default, and a final the focused button names still asks', () => {
    expect(judge(sheet('Send', 'e8'))).toMatchObject({ kind: 'send', on: 'Send' })
    expect(judge(sheet('OK', 'e5'))).toMatchObject({ kind: 'delete' })
  })

  it('a text area keeps its Return (a new line), Space presses the focused part, and a Finder row starts a rename', () => {
    expect(judge(sheet('Delete', 'e4'))).toBeNull()
    expect(judge(sheet('Send', 'e1'), ret('Lantern', 'space'))).toBeNull()
    expect(judge(sheet('Delete', 'e2', 'Finder'), ret('Finder'))).toBeNull()
  })
})

describe('a web composer exposed as a group (contenteditable): a settable group is a message box', () => {
  const page = (more = {}) => ({
    id: 'look-web', tag: 'cd34', app: 'Google Chrome', window: 'kettle-room (Channel) - Puzzlebox - Slack', focused: 'e9',
    elements: [
      el('e3', 'AXWebArea', 'kettle-room (Channel) - Puzzlebox - Slack', [0, 80, 1200, 800], { in: '' }),
      el('e9', 'AXGroup', 'Message Mira Bakker', [220, 800, 900, 40], { in: 'Slack', settable: true, ...more }),
    ],
  })
  /** A native app no list names, its composer a settable group with Send beside it. */
  const quill = (more = {}) => ({
    id: 'look-quill', tag: 'ef56', app: 'Quill', window: 'kettle-room', focused: 'e5',
    elements: [el('e5', 'AXGroup', 'Message #kettle-room', [300, 700, 600, 40], { in: 'composer', settable: true, ...more }), el('e6', 'AXButton', 'Send', [910, 705, 30, 30], { in: 'composer' })],
  })

  it('Return in a chat page whose box is a settable group sends, naming the conversation', () => {
    expect(judge(page(), ret('Google Chrome'))).toMatchObject({ kind: 'send', on: 'Message Mira Bakker', to: ['Mira Bakker'] })
    expect(judge(page({ sub: 'AXUnknown' }), ret('Google Chrome'))).toMatchObject({ kind: 'send' })
  })

  it('a native app whose group box shows Send beside it sends; Shift+Return adds a line', () => {
    expect(judge(quill(), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Send', on: 'Message #kettle-room' })
    expect(judge(quill(), ret('Quill', 'shift+return'))).toBeNull()
  })

  it('a group that takes no value is no box: Return there is read as before', () => {
    expect(judge(quill({ settable: false }), ret('Quill'))).toBeNull()
  })

  it('a group the app calls a text entry area, or editable, is a box though its value is not settable; a plain "group" is not', () => {
    expect(judge(quill({ settable: false, roleDescription: 'text entry area' }), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Send' })
    expect(judge(quill({ settable: false, editable: true }), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Send' })
    expect(judge(quill({ settable: false, roleDescription: 'group' }), ret('Quill'))).toBeNull()
  })
})

describe('two message boxes in one container (a thread pane beside the main one): the Send nearest the box', () => {
  /** A native app no list names: the main composer and a thread's, each with its own Send, all in one container. */
  const panes = (focused, extra = []) => ({
    id: 'look-panes', tag: 'aa77', app: 'Quill', window: 'kettle-room', focused,
    elements: [
      el('e5', 'AXTextArea', 'Message #kettle-room', [300, 700, 500, 40], { in: 'Quill', settable: true }),
      el('e6', 'AXButton', 'Send', [810, 705, 30, 30], { in: 'Quill' }),
      el('e7', 'AXTextArea', 'Reply to Mira Bakker', [900, 700, 300, 40], { in: 'Quill', settable: true }),
      el('e8', 'AXButton', 'Reply', [1210, 705, 50, 30], { in: 'Quill' }),
      ...extra,
    ],
  })

  it('Return in either box sends with its own button, naming that box', () => {
    expect(judge(panes('e5'), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Send', on: 'Message #kettle-room' })
    expect(judge(panes('e7'), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Reply', on: 'Reply to Mira Bakker', to: ['Mira Bakker'] })
    // An Electron wrapper around the box (a settable group with no words) is the same box, not another.
    expect(judge(panes('e7', [el('e9', 'AXGroup', '', [895, 695, 310, 50], { in: 'Quill', settable: true })]), ret('Quill'))).toMatchObject({ kind: 'send', what: 'Reply' })
  })

  it('a form body (To and Subject beside it) is still a new line, and a Send nearer another box is not this box\'s', () => {
    const mail = { id: 'look-form', tag: 'bb88', app: 'Quill', window: 'New message', focused: 'e3', elements: [el('e1', 'AXTextField', 'To', [100, 100, 400, 22], { in: 'compose' }), el('e2', 'AXTextField', 'Subject', [100, 130, 400, 22], { in: 'compose' }), el('e3', 'AXTextArea', 'Body', [100, 160, 400, 300], { in: 'compose' }), el('e4', 'AXButton', 'Send', [440, 470, 60, 24], { in: 'compose' })] }
    expect(judge(mail, ret('Quill'))).toBeNull()
    const far = panes('e5', [])
    far.elements = far.elements.filter((x) => x.ref !== 'e6')
    expect(judge(far, ret('Quill'))).toBeNull()
  })
})

describe("a chat's own navigator field is no message box; a box named for a channel is one whatever the channel's name", () => {
  const inField = (role, name, app = 'Element') => finalOf('screen_act', { app, action: 'key', value: 'return' }, undefined, [{ verb: 'keyboard', app, thing: { role, name } }, ...ret(app)])
  it('Jump to, Find, Go to, Filter and the quick switcher run a search, not a send', () => {
    for (const name of ['Jump to…', 'Jump to', 'Find', 'Find in conversation', 'Go to', 'Go to file', 'Filter channels', 'Quick switcher', 'Quick Switcher', 'Search'])
      expect(inField('text field', name), name).toBeNull()
  })

  it('a one-line field named anything else in a chat still sends, erring toward asking', () => {
    expect(inField('text field', 'Message Mira Bakker')).toMatchObject({ kind: 'send', to: ['Mira Bakker'] })
    expect(inField('text field', 'Findings for BOX-484')).toMatchObject({ kind: 'send' })
  })

  it('a replayed route ending in a plain Return in a chat is judged on its steps and asks (routeFor lets it through to here)', () => {
    const steps = [{ action: 'focus', role: 'text area', label: 'Message #kettle-room' }, { action: 'type', value: 'kettle count 4821' }, { action: 'key', value: 'return' }]
    const args = { app: 'Element', goal: 'post the count', steps }
    expect(finalOf('screen_act', args)).toMatchObject({ kind: 'final-unknown', app: 'Element' })
    const plans = [{ verb: 'focus', app: 'Element', thing: { role: 'text area', name: 'Message #kettle-room' } }, { verb: 'type', app: 'Element', thing: {}, command: { value: 'kettle count 4821' } }, ...ret('Element')]
    expect(finalOf('screen_act', args, undefined, plans)).toMatchObject({ kind: 'send', on: 'Message #kettle-room' })
    expect(decide('screen_act', args, { plans })).toMatchObject({ kind: 'ask' })
  })

  it('a message box named for a channel whose name holds search, location or url sends', () => {
    for (const name of ['Message #search-team', 'Message #location-scouting', 'Reply to #url-shortener'])
      expect(inField('text area', name), name).toMatchObject({ kind: 'send' })
  })
})

describe("a web form's final is the one in the field's own form, not the first on the page", () => {
  /** A settings page: a Note field in its Profile section, an Update button in another; a Feedback form with its own Send. */
  const page = (more = {}) => ({
    id: 'look-form', tag: 'cc99', app: 'Google Chrome', window: 'Lantern settings', focused: 'e2',
    elements: [
      el('e1', 'AXWebArea', 'Lantern settings', [0, 80, 1200, 900], { in: '' }),
      el('e2', 'AXTextField', 'Note', [100, 150, 300, 22], { in: 'Profile', settable: true, ...more }),
      el('e3', 'AXButton', 'Update', [100, 600, 80, 24], { in: 'Software' }),
      el('e4', 'AXTextField', 'Your words', [100, 800, 300, 22], { in: 'Feedback', settable: true }),
      el('e5', 'AXButton', 'Send', [420, 800, 60, 24], { in: 'Feedback' }),
    ],
  })
  it('Return in Note is no Update; Return in the feedback field is its Send', () => {
    expect(judge(page(), ret('Google Chrome'))).toBeNull()
    const inFeedback = [{ verb: 'focus', app: 'Google Chrome', thing: { role: 'text field', name: 'Your words' } }, ...ret('Google Chrome')]
    expect(judge(page(), inFeedback)).toMatchObject({ kind: 'send', what: 'Send', on: 'Your words' })
  })

  it('a field with no container is read against the whole page, erring toward asking', () => {
    expect(judge(page({ in: '' }), ret('Google Chrome'))).toMatchObject({ kind: 'update', what: 'Update' })
  })
})

describe('a bare Return sent by System Events from the shell: a send in a chat, a final-unknown where the app is not known', () => {
  const se = (keys, app) => `osascript${app ? ` -e 'tell application "${app}" to activate'` : ''} -e 'tell application "System Events" to ${keys}'`
  const RETURNS = ['key code 36', 'key code 76', 'keystroke return', 'keystroke enter', 'keystroke "kettle count 4821" & return', 'keystroke (ASCII character 13)']
  it('into a chat app: a blind Send, refused in every mode, by gnomon_run_shell and bash alike', () => {
    for (const keys of RETURNS)
      for (const tool of ['gnomon_run_shell', 'bash']) {
        const command = se(keys, 'Element')
        expect(finalOf(tool, { command }), `${tool} ${keys}`).toMatchObject({ kind: 'send', via: 'shell', blind: true })
        for (const testMode of [false, true]) expect(decide(tool, { command }, { testMode })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/blind Send/) })
      }
    expect(finalOf('bash', { command: `osascript -e 'tell application "System Events" to tell process "Microsoft Teams" to key code 36'` })).toMatchObject({ kind: 'send', blind: true })
    expect(finalOf('bash', { command: `osascript -l JavaScript -e 'Application("Element").activate(); Application("System Events").keyCode(36)'` })).toMatchObject({ kind: 'send', blind: true })
    expect(finalOf('bash', { command: `osascript -l JavaScript -e 'Application("System Events").keyCode(36, {using: "command down"})'` })).toMatchObject({ kind: 'final-unknown' })
    // cmd+Return by its name is a send key wherever it lands.
    expect(decide('bash', { command: se('keystroke return using {command down}', 'TextEdit') })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/blind Send/) })
  })

  it('no app named, or one no list knows: a final-unknown that asks, naming where it lands', () => {
    for (const keys of RETURNS) expect(finalOf('gnomon_run_shell', { command: se(keys) }), keys).toMatchObject({ kind: 'final-unknown', via: 'shell', blind: false })
    const command = se('key code 36', 'Quill')
    expect(decide('gnomon_run_shell', { command })).toMatchObject({ kind: 'ask' })
    expect(finalAsk(finalOf('gnomon_run_shell', { command }), { command })).toMatch(/^Gnomon: this Return in Quill lands on a part Gnomon cannot read for certain \(a Return sent by System Events lands wherever the keyboard is\)/)
  })

  it('an editor, a terminal or a mail app keeps its Return; a new line (shift, option) and a key that is no Return are not finals', () => {
    for (const app of ['TextEdit', 'Terminal', 'Visual Studio Code', 'Spark']) expect(finalOf('bash', { command: se('key code 36', app) }), app).toBeNull()
    for (const keys of ['key code 36 using shift down', 'keystroke return using {option down}', 'key code 48', 'keystroke "f" using {command down}', 'keystroke "kettle"'])
      expect(finalOf('bash', { command: se(keys, 'Element') }), keys).toBeNull()
  })
})
