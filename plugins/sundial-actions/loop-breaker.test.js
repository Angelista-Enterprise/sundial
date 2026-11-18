import { describe, expect, it } from 'vitest'
import { LIMITS, breakerOf, missed, thingsOf, turnCalls } from './loop-breaker.js'

// A chat log as dsh writes it: tool/call with its arguments as a JSON string, tool/result citing the call id.
const log = () => {
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'user' } } }]
  const add = (name, args, text = 'done', isError = false) => {
    const callId = `call-${events.length}`
    events.push({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
    events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } } })
    return add
  }
  return { events, add }
}
const rename = { app: 'Finder', goal: 'rename notes.txt', steps: [{ action: 'click', ref: 'e73@a06ce0' }, { action: 'key', value: 'return' }] }
const nothing = '1. Click "notes.txt" in Finder: sent\n2. Key in Finder: "return": sent, but nothing on screen changed'

describe('the loop breaker (runs 190, 193, 198: the same failing step until the 180 s timeout)', () => {
  it('refuses the next act on a thing that failed or changed nothing four times, and says stop and ask', () => {
    const { events, add } = log()
    add('screen_act', rename, nothing)('screen_look', { app: 'Finder' }, 'look')('screen_act', { app: 'Finder', steps: [{ action: 'set-value', ref: 'e73@a06ce0', value: 'Juniper.txt' }] }, 'Error: 1. Set-value "e73": refused: ax-cannot-complete', true)
    add('screen_act', { app: 'Finder', action: 'pick-menu', value: 'File > Rename', ref: 'e73@b11111' }, 'Sent (pick-menu), but nothing on screen changed')
    expect(breakerOf('screen_act', rename, events)).toBeNull()
    add('screen_act', { ...rename, goal: 'try again' }, 'Error: rename-not-seen', true)
    const stop = breakerOf('screen_act', { app: 'Finder', steps: [{ action: 'set-value', ref: 'e73@a06ce0', value: 'x', replace: true }] }, events)
    expect(stop).toMatchObject({ kind: 'deny', breaker: 'loop', app: 'Finder' })
    expect(stop.reason).toContain('acting on "e73" failed or changed nothing 4 times')
    expect(stop.reason).toContain('ask the owner')
    // Another thing in the same app is not that loop.
    expect(breakerOf('screen_act', { app: 'Finder', steps: [{ action: 'click', label: 'Action' }] }, events)).toBeNull()
  })

  it('once it has spoken, every screen act and shell command left in the turn is refused; a new turn starts clean', () => {
    const { events, add } = log()
    add('screen_act', { app: 'Finder', action: 'press', ref: 'e1' }, 'Gnomon stopped this turn: acting on "e1" failed', true)
    expect(breakerOf('screen_act', { app: 'Finder', action: 'press', label: 'Other' }, events)?.reason).toContain('you were told to stop')
    expect(breakerOf('gnomon_run_shell', { command: 'ls /tmp' }, events)?.kind).toBe('deny')
    expect(breakerOf('screen_look', { app: 'Finder' }, events)).toBeNull()
    events.push({ type: 'turn/start', data: { turn: 2 } })
    expect(breakerOf('screen_act', { app: 'Finder', action: 'press', ref: 'e1' }, events)).toBeNull()
  })

  it('a correction from the owner inside the turn is a new goal: the count starts again there', () => {
    const { events, add } = log()
    for (let i = 0; i < LIMITS.fails; i++) add('screen_act', rename, nothing)
    expect(breakerOf('screen_act', rename, events)?.kind).toBe('deny')
    events.push({ type: 'user/message', data: { source: { kind: 'user' } } })
    expect(breakerOf('screen_act', rename, events)).toBeNull()
    // A notice or a compaction checkpoint is not the owner speaking.
    events.splice(-1, 1, { type: 'user/message', data: { source: { kind: 'sundial-shell', form: 'notice' } } })
    expect(breakerOf('screen_act', rename, events)?.kind).toBe('deny')
  })

  it('a call refused for its shape (arguments, the gate, a set-value that needs replace) is not the screen saying no', () => {
    expect(missed({ name: 'screen_act', args: rename, text: 'Error: invalid arguments: at most 8 steps', isError: true })).toBe(false)
    expect(missed({ name: 'screen_act', args: rename, text: 'Error: step 1: invalid arguments: give a ref', isError: true })).toBe(false)
    expect(missed({ name: 'screen_act', args: rename, text: 'Error: Gnomon: refused, a final step with no app named.', isError: true })).toBe(false)
    expect(missed({ name: 'screen_act', args: rename, text: `Error: 1. Set-value "Item": refused: "Item" already held the owner's text`, isError: true })).toBe(false)
    // Run 185 nested its steps in `item`: the act read none of them.
    expect(missed({ name: 'screen_act', args: { steps: { item: [] } }, text: '1. Open Zen: sent, but nothing on screen changed' })).toBe(false)
    expect(missed({ name: 'screen_act', args: rename, text: nothing })).toBe(true)
    expect(missed({ name: 'screen_look', args: {}, text: 'Nothing on screen changed.' })).toBe(false)
  })

  it('doc 31 (run 257 T19): a "look again" refusal is no failed act: four of them on the go-to field, and its Return still goes', () => {
    const { events, add } = log()
    const field = (action, more = {}) => ({ app: 'Finder', goal: 'open the folder', action, ref: 'e117@4d5710', ...more })
    const stale = (verb) => `Error: 1. ${verb} "e117": refused: look again. The screen changed since the look: call screen_look, then act on a ref from it.`
    add('screen_act', field('set-value', { value: '/tmp/gnomon-x/Box', replace: true }), stale('Set-value'), true)('screen_look', { app: 'Finder' }, 'look')
    add('screen_act', field('set-value', { value: '/tmp/gnomon-x/Box', replace: true }), stale('Set-value'), true)('screen_look', { app: 'Finder' }, 'look')
    add('screen_act', field('click'), stale('Click'), true)('screen_look', { app: 'Finder' }, 'look')
    add('screen_act', field('key', { value: 'cmd+a' }), 'Error: refused: e117@4d5710 is in no recent look of Finder: look again. The screen changed since the look.', true)
    add('screen_act', { app: 'Finder', action: 'type', value: '/tmp/gnomon-x/Box' }, 'Done (type).')
    expect(missed({ name: 'screen_act', args: field('click'), text: stale('Click'), isError: true })).toBe(false)
    expect(breakerOf('screen_act', field('key', { value: 'return' }), events)).toBeNull()
    // The same call refused "look again" twice in a row is still the same call: a third is refused, so it cannot spin.
    const { events: spin, add: again } = log()
    again('screen_act', field('click'), stale('Click'), true)('screen_look', { app: 'Finder' }, 'look')('screen_act', field('click'), stale('Click'), true)
    expect(breakerOf('screen_act', field('click'), spin)?.reason).toContain('already ran 2 times in a row')
  })

  it('refuses the same call with the same arguments a third time in a row; a look between does not break the row, another call does', () => {
    const { events, add } = log()
    const find = { command: 'touch /tmp/gnomon-run1/box' }
    add('gnomon_run_shell', find, 'exit 0')('screen_look', { app: 'Finder' }, 'look')('gnomon_run_shell', find, 'exit 0')
    expect(breakerOf('gnomon_run_shell', find, events)?.reason).toContain('already ran 2 times in a row')
    const { events: other, add: more } = log()
    more('gnomon_run_shell', find, 'exit 0')('screen_act', { app: 'Finder', action: 'press', label: 'Next' }, 'Done (press).')('gnomon_run_shell', find, 'exit 0')
    expect(breakerOf('gnomon_run_shell', find, other)).toBeNull()
    // A screen act that worked is a flow, not a loop: Next, Next, Next.
    const { events: wizard, add: next } = log()
    next('screen_act', { app: 'Installer', action: 'press', label: 'Continue' }, 'Done (press).')('screen_act', { app: 'Installer', action: 'press', label: 'Continue' }, 'Done (press).')
    expect(breakerOf('screen_act', { app: 'Installer', action: 'press', label: 'Continue' }, wizard)).toBeNull()
  })

  it('Fable M1: a read-only shell polled again and again (git status, a port) is a wait, not a loop, and locks nothing', () => {
    const { events, add } = log()
    const poll = { command: 'git status --short' }
    add('gnomon_run_shell', poll, 'exit 0')('gnomon_run_shell', poll, 'exit 0')
    expect(breakerOf('gnomon_run_shell', poll, events)).toBeNull()
  })

  it('Fable M1: only a stop on a screen act locks the rest of the turn; a shell-hunt stop leaves screen acts free', () => {
    const { events, add } = log()
    add('screen_act', { app: 'Finder', action: 'press', label: 'A' }, 'Error: refused: not-found', true)('gnomon_run_shell', { command: 'find /tmp -name x' }, 'Error: Gnomon stopped this turn: 4 shell searches in a row', true)
    expect(breakerOf('screen_act', { app: 'Finder', action: 'press', label: 'B' }, events)).toBeNull()
  })

  it("Fable M2: after a stop, screen_undo still runs, so the owner's replaced text can be put back", () => {
    const { events, add } = log()
    add('screen_act', { app: 'Finder', action: 'set-value', ref: 'e1', value: 'x' }, 'Error: Gnomon stopped this turn: acting on "e1" failed', true)
    expect(breakerOf('screen_undo', { because: 'put the name back' }, events)).toBeNull()
    expect(breakerOf('screen_act', { app: 'Finder', action: 'press', label: 'B' }, events)?.kind).toBe('deny')
  })

  it('Fable M3: a stop in a private app names neither the app nor the thing on the record', () => {
    const { events, add } = log()
    const step = { app: 'Messages', action: 'click', label: 'Mira Bakker' }
    for (let i = 0; i < LIMITS.fails; i++) add('screen_act', step, nothing)
    const stop = breakerOf('screen_act', step, events)
    expect(stop).toMatchObject({ kind: 'deny', breaker: 'loop', app: null })
    expect(stop.reason).not.toContain('Mira')
    expect(stop.reason).toContain('one thing in a private app')
  })

  it('Fable LOW: a call outside a turn (an offer pressed on an idle chat) starts fresh', () => {
    const { events, add } = log()
    const step = { app: 'Finder', action: 'press', label: 'Play' }
    add('screen_act', step, nothing)('screen_act', step, nothing)
    expect(breakerOf('screen_act', step, events)?.kind).toBe('deny')
    events.push({ type: 'turn/end', data: { turn: 1 } })
    expect(breakerOf('screen_act', step, events)).toBeNull()
  })

  it('reads a call made through gnomon_call as the tool inside it', () => {
    const { events, add } = log()
    for (let i = 0; i < LIMITS.fails; i++) add('gnomon_call', { name: 'screen_act', args: rename }, nothing)
    expect(turnCalls(events)[0].name).toBe('screen_act')
    expect(breakerOf('gnomon_call', JSON.stringify({ name: 'screen_act', args: rename }), events)?.kind).toBe('deny')
  })

  it('names a step by its ref without the window part, else its label, text or menu path', () => {
    expect(thingsOf({ app: 'Finder', steps: [{ action: 'click', ref: 'e73@a06ce0' }, { action: 'pick-menu', value: 'File > Rename' }, { action: 'key', value: 'return' }, { action: 'click', role: 'button', label: 'Action' }] })).toEqual(['finder\ne73', 'finder\nfile > rename', 'finder\naction'])
  })
})

describe('the shell-hunt cap (runs 179, 183, 198 T17: 11 to 17 shell searches after a screen step failed)', () => {
  const look = (add) => add('screen_look', { app: 'Finder' }, 'Error: refused: not-running', true)
  it('refuses the fifth read-only shell command in a row in a screen task, and says stop searching', () => {
    const { events, add } = log()
    look(add)
    for (const c of ['find /tmp -name notes.txt', 'ls -la /private/tmp', 'mdfind -name notes.txt', 'grep -rn Kettle /tmp/x']) add('gnomon_run_shell', { command: c }, 'exit 0')
    const stop = breakerOf('gnomon_run_shell', { command: 'ls /tmp/gnomon-run1' }, events)
    expect(stop).toMatchObject({ kind: 'deny', breaker: 'hunt', app: 'Finder' })
    expect(stop.reason).toContain('Stop searching: say what you found')
  })

  it('a shell read right after an act is a check of what it did: the run starts again at every act', () => {
    const { events, add } = log()
    look(add)
    for (let i = 0; i < 6; i++) add('gnomon_run_shell', { command: `ls /tmp/gnomon-run1/try${i}` }, 'exit 0')('screen_act', { app: 'Finder', action: 'press', label: `B${i}` }, 'Done (press).')
    expect(breakerOf('gnomon_run_shell', { command: 'ls /tmp/gnomon-run1' }, events)).toBeNull()
  })

  it('Fable M1: after screen calls that all worked, shell reads are no hunt', () => {
    const { events, add } = log()
    add('screen_look', { app: 'Finder' }, 'look')('screen_act', { app: 'Finder', action: 'press', label: 'Go' }, 'Done (press).')
    for (let i = 0; i < 6; i++) add('gnomon_run_shell', { command: `cat /tmp/gnomon-run1/f${i}` }, 'exit 0')
    expect(breakerOf('gnomon_run_shell', { command: 'cat /tmp/gnomon-run1/g' }, events)).toBeNull()
  })

  it('leaves a turn that never touched the screen alone, and never counts a shell write', () => {
    const { events, add } = log()
    for (let i = 0; i < 6; i++) add('gnomon_run_shell', { command: `cat /tmp/f${i}` }, 'exit 0')
    expect(breakerOf('gnomon_run_shell', { command: 'cat /tmp/g' }, events)).toBeNull()
    look(add)
    expect(breakerOf('gnomon_run_shell', { command: 'cat /tmp/g' }, events)?.breaker).toBe('hunt')
    expect(breakerOf('gnomon_run_shell', { command: 'mv /tmp/a /tmp/b' }, events)).toBeNull()
  })
})

describe('the screen-hunt cap (runs 238, 240 T27: 43 and 15 steps for a button Calculator does not have, every step a success)', () => {
  const CALC = 'Calculator'
  const miss = (q) => `Screen data.\nNothing matches "${q}". The top of the window:\nbutton "Clear" [e5@f00d01]\nbutton "Mode" [e27@f00d01]`
  // Run 238 T27 as made-up steps: a menu read, a view, a look, a sidebar, a look again.
  const hunt = () => {
    const { events, add } = log()
    add('gnomon_run_shell', { command: "printf 'onyx 790\\n' > /tmp/gnomon-run9238/first.txt" }, '')
    add('screen_look', { app: CALC }, 'Screen data.\nbutton "Clear" [e5@f00d01]')
    add('screen_look', { app: CALC, menu: 'View' }, 'View holds: "Basic", "Scientific", "Programmer", "Math Notes".')
    add('screen_act', { app: CALC, action: 'pick-menu', value: 'View > Math Notes', because: 'open the Math Notes view where the Archive button lives' }, '1. Pick "View > Math Notes" in Calculator: done')
    add('screen_look', { app: CALC, query: 'Archive' }, miss('Archive'))
    expect(breakerOf('screen_act', { ref: 'e26@f00d01', action: 'click', because: 'open the sidebar where the Archive button sits' }, events)).toBeNull()
    add('screen_act', { ref: 'e26@f00d01', action: 'click', because: 'open the sidebar where the Archive button sits' }, '1. Click "Show Sidebar" in Calculator: done')
    add('screen_look', { app: CALC, query: 'Archive' }, miss('Archive'))
    return { events, add }
  }

  it('two looks that found nothing: the next look or act for it is refused with a plain "is not there", menus, sidebars and views too', () => {
    const { events } = hunt()
    const scroll = breakerOf('screen_act', { ref: 'e58@f00d01', action: 'scroll', value: '40', because: 'scroll to the bottom of the notes list where the Archive button is' }, events)
    expect(scroll).toMatchObject({ kind: 'deny', breaker: 'seek', app: CALC })
    expect(scroll.reason).toMatch(/^"Archive" is not there: 2 looks for it in this turn found nothing/)
    expect(scroll.reason).toContain('go on with the rest of the task')
    expect(breakerOf('screen_act', { app: CALC, action: 'pick-menu', value: 'View > Programmer', because: 'switch to Programmer mode where the Archive button lives' }, events)?.breaker).toBe('seek')
    expect(breakerOf('screen_look', { app: CALC, query: 'Archive 5120' }, events)?.breaker).toBe('seek')
    expect(breakerOf('screen_act', { app: CALC, action: 'press', find: 'Archive 5120' }, events)?.breaker).toBe('seek')
  })

  it('never a stop of the turn: the rest of the task, a plain look and other work in the app go on', () => {
    const { events } = hunt()
    expect(breakerOf('gnomon_run_shell', { command: "printf 'fennel 791\\n' > /tmp/gnomon-run9238/last.txt" }, events)).toBeNull()
    expect(breakerOf('screen_look', { app: CALC }, events)).toBeNull()
    expect(breakerOf('screen_act', { app: CALC, action: 'press', find: 'Clear', because: 'clear the display' }, events)).toBeNull()
    expect(breakerOf('screen_look', { app: CALC, query: 'Mode' }, events)).toBeNull()
  })

  it('one miss is a look, not a hunt; a look since that shows it (a match, a menu, a whole window) found it', () => {
    const one = log()
    one.add('screen_look', { app: CALC, query: 'Archive' }, miss('Archive'))
    expect(breakerOf('screen_act', { app: CALC, action: 'pick-menu', value: 'View > Math Notes', because: 'find the Archive button' }, one.events)).toBeNull()
    for (const shown of ['Screen data.\nbutton "Archive 5120" [e40@f00d01]', 'File holds: "New", "Archive", "Close".']) {
      const { events, add } = hunt()
      add('screen_look', { app: CALC }, shown)
      expect(breakerOf('screen_act', { ref: 'e40@f00d01', action: 'press', because: 'press the Archive button' }, events), shown).toBeNull()
    }
    // A query's own echo is no showing: "Nothing matching ... is new" found nothing.
    const { events, add } = hunt()
    add('screen_look', { app: CALC, query: 'Archive' }, 'Screen data.\nNothing matching "Archive" is new: what you look for is in the lines you already have, or not in this window.')
    expect(breakerOf('screen_look', { app: CALC, query: 'Archive' }, events)?.breaker).toBe('seek')
  })

  it('a look again with nothing done since is the same miss: a page still drawing is waited for, not called missing', () => {
    const { events, add } = log()
    add('screen_look', { app: 'Gnomon Rig Chromium', query: 'Start' }, miss('Start'))('gnomon_await', { seconds: 5 }, 'waited')('screen_look', { app: 'Gnomon Rig Chromium', query: 'Start' }, miss('Start'))
    expect(breakerOf('screen_look', { app: 'Gnomon Rig Chromium', query: 'Start' }, events)).toBeNull()
    add('screen_act', { app: 'Gnomon Rig Chromium', action: 'key', value: 'cmd+r', because: 'reload to show Start' }, '1. Key: done')('screen_look', { app: 'Gnomon Rig Chromium', query: 'Start' }, miss('Start'))
    expect(breakerOf('screen_look', { app: 'Gnomon Rig Chromium', query: 'Start' }, events)?.breaker).toBe('seek')
  })

  it('screen text that holds it is no miss, plain words are no thing, and the owner speaking starts the count again', () => {
    const ocr = log()
    for (let i = 0; i < 2; i++) ocr.add('screen_look', { app: CALC, query: 'Archive' }, `${miss('Archive')}\nThe screen text the app shows also holds these lines, which the look does not list (act on one by {app, text}):\n"Archive 5120"`)
    expect(breakerOf('screen_look', { app: CALC, query: 'Archive' }, ocr.events)).toBeNull()
    const plain = log()
    for (let i = 0; i < 2; i++) plain.add('screen_look', { app: CALC, query: 'the button' }, miss('the button'))
    expect(breakerOf('screen_act', { app: CALC, action: 'press', find: 'Clear', because: 'press the button' }, plain.events)).toBeNull()
    const { events } = hunt()
    events.push({ type: 'user/message', data: { source: { kind: 'user' } } })
    expect(breakerOf('screen_look', { app: CALC, query: 'Archive' }, events)).toBeNull()
  })

  // Run 252 T21: two looks for "Outbox" in a Save panel found nothing, the shell then listed the folder, and seven acts that named
  // Outbox were refused (go-to-folder, set-value, pick, press, click). Made-up values.
  const TE = 'TextEdit'
  const outbox = () => {
    const { events, add } = log()
    add('screen_look', { app: TE, query: 'Outbox' }, miss('Outbox'))
    add('screen_act', { app: TE, ref: 'e22@f00d02', action: 'click', because: 'open the run folder column' }, '1. Click "e22" in TextEdit: done')
    add('screen_look', { app: TE, query: 'Outbox' }, miss('Outbox'))
    return { events, add }
  }

  it('a shell listing that shows the word found it: the count starts again', () => {
    const { events, add } = outbox()
    expect(breakerOf('screen_act', { app: TE, ref: 'e40@f00d02', action: 'click', because: 'open the Outbox folder' }, events)?.breaker).toBe('seek')
    add('gnomon_run_shell', { command: 'ls -la /tmp/gnomon-x/Testbox-where' }, 'total 0\ndrwxr-xr-x  2 mira  wheel  64 Drafts\ndrwxr-xr-x  2 mira  wheel  64 Outbox')
    expect(breakerOf('screen_act', { app: TE, ref: 'e40@f00d02', action: 'click', because: 'open the Outbox folder' }, events)).toBeNull()
    // A listing without it changes nothing.
    const other = outbox()
    other.add('gnomon_run_shell', { command: 'ls /tmp/gnomon-x' }, 'Drafts')
    expect(breakerOf('screen_act', { app: TE, ref: 'e40@f00d02', action: 'click', because: 'open the Outbox folder' }, other.events)?.breaker).toBe('seek')
  })

  it('a folder named in a Save panel path step is no hunt: save-as and go-to-folder go, words of its path included', () => {
    const { events } = outbox()
    expect(breakerOf('screen_act', { app: TE, action: 'go-to-folder', value: '/tmp/gnomon-x/Testbox-where/Outbox', because: 'navigate the save panel to the Outbox folder' }, events)).toBeNull()
    expect(breakerOf('screen_act', { app: TE, steps: [{ action: 'save-as', value: '/tmp/gnomon-x/Testbox-where/Outbox/crates-118.txt' }], because: 'save into Outbox' }, events)).toBeNull()
    // Another word in the same call is still a hunt.
    expect(breakerOf('screen_act', { app: TE, action: 'save-as', value: '/tmp/gnomon-x/Drafts/crates-118.txt', because: 'save next to Outbox' }, events)?.breaker).toBe('seek')
  })
})
