// Set 2 Round 1: an ask the rig and the owner can read. Every final names its kind and its target, a Finder delete names the
// file, a Return nobody can read names what the keyboard was last on, and a shell ask carries its command and what it touches.
// The four Set 1 refusals (runs 150, 154, 155) as made-up equivalents. Every value is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, commandLine, decideAction, finalAsk, finalOf, touchesLine, touchesOf } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }

const key = (app, value) => ({ verb: 'key', app, thing: { name: '' }, command: { action: 'key', value } })
const typed = (app, value, thing = { name: '' }) => ({ verb: 'type', app, thing, command: { action: 'type', value } })
const ask = (toolName, args, plans, opts) => finalAsk(finalOf(toolName, args, undefined, plans), opts)
/** The sentence the record strips (sundial-theme host/server.js stepLine): what is left must be the step line alone. */
const recorded = (reason) => reason.split(' · ')[0].replace(/^Gnomon: this .*?, so it asks you first\.\s*/, '').trim()

describe('every final names its kind and its target', () => {
  it('a press names the control, its app and its window; a delete names what it deletes', () => {
    const del = { app: 'Zen', role: 'button', label: 'Delete the message from Mira Bakker' }
    const reason = ask('screen_act', del, [], { line: 'Press "Delete the message from Mira Bakker" in Zen', window: 'Testbox' })
    expect(reason).toBe('Gnomon: this deletes "the message from Mira Bakker" in Zen (window "Testbox"), which cannot be taken back, so it asks you first. Press "Delete the message from Mira Bakker" in Zen · final: delete')
    expect(recorded(reason)).toBe('Press "Delete the message from Mira Bakker" in Zen')
    const cells = [
      ['send', { app: 'Zen', role: 'button', label: 'Send' }, 'sends a mail or a message with "Send" in Zen'],
      ['submit', { app: 'Zen', role: 'button', label: 'Place order' }, 'submits a form with "Place order" in Zen'],
      ['discard', { app: 'TextEdit', role: 'button', label: "Don't Save" }, `discards unsaved changes with "Don't Save" in TextEdit`],
      ['pay', { app: 'Zen', role: 'button', label: 'Buy now' }, 'pays or buys with "Buy now" in Zen'],
      ['post', { app: 'Zen', role: 'button', label: 'Publish' }, 'posts in public with "Publish" in Zen'],
      ['send', { app: 'Zen', action: 'key', value: 'cmd+enter' }, 'sends a mail or a message with cmd+enter in Zen'],
    ]
    for (const [kind, args, words] of cells) expect(ask('screen_act', args, []), kind).toMatch(new RegExp(`^Gnomon: this ${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which cannot be taken back, so it asks you first\\. · .*final: ${kind}$`))
    // A web final names the element its ref reads; a shell delete names its files.
    const page = (id, ref) => (id === 'p1' && ref === 2 ? { ref: 2, role: 'button', name: 'Place order' } : null)
    expect(finalAsk(finalOf('web_act', { page: 'p1', ref: 2, action: 'click' }, page))).toBe('Gnomon: this submits a form with "Place order" on a web page, which cannot be taken back, so it asks you first. · final: submit')
    expect(finalAsk(finalOf('gnomon_run_shell', { command: 'rm /tmp/gnomon-run160/old.log' }), { command: 'rm /tmp/gnomon-run160/old.log' })).toMatch(/^Gnomon: this deletes "\/tmp\/gnomon-run160\/old\.log" from the shell, which cannot/)
  })

  it('a title or a label with " · " in it never cuts the sentence the record strips', () => {
    const reason = ask('screen_act', { app: 'Zen', role: 'button', label: 'Send · now' }, [], { line: 'Press "Send - now" in Zen', window: 'Inbox · Testbox' })
    expect(reason).toContain('(window "Inbox - Testbox")')
    expect(recorded(reason)).toBe('Press "Send - now" in Zen')
  })

  it('a Finder delete names the file it moves to the Trash: the selected row, by key or by menu', () => {
    const row = { verb: 'select', app: 'Finder', thing: { role: 'row', name: 'Testbox-old.log' } }
    const bykey = finalOf('screen_act', { app: 'Finder', action: 'key', value: 'cmd+backspace' }, undefined, [row, key('Finder', 'cmd+backspace')])
    expect(bykey).toMatchObject({ kind: 'delete', app: 'Finder', last: 'Testbox-old.log' })
    expect(finalAsk(bykey, { line: 'Key in Finder: cmd+backspace', window: 'gnomon-run160' })).toBe('Gnomon: this moves "Testbox-old.log" to the Trash in Finder (window "gnomon-run160"), which cannot be taken back, so it asks you first. Key in Finder: cmd+backspace · final: delete')
    const click = { verb: 'click', app: 'Finder', thing: { role: 'cell', name: 'Testbox-old.log' } }
    expect(ask('screen_act', { app: 'Finder', action: 'pick-menu', value: 'Move to Trash' }, [click, { verb: 'pick-menu', app: 'Finder', thing: { role: 'menu item', name: 'Move to Trash' } }])).toMatch(/^Gnomon: this moves "Testbox-old\.log" to the Trash in Finder, which cannot/)
    // An arrow after the select moved the selection: the ask says so and names no file it cannot be sure of.
    expect(ask('screen_act', { app: 'Finder', action: 'key', value: 'cmd+backspace' }, [row, key('Finder', 'down'), key('Finder', 'cmd+backspace')])).toMatch(/^Gnomon: this moves the selected items to the Trash in Finder \(the keyboard was last on "Testbox-old\.log", then down moved it\), which cannot/)
    expect(ask('screen_act', { app: 'Finder', action: 'pick-menu', value: 'Empty Trash' }, [])).toMatch(/^Gnomon: this deletes with "Empty Trash" in Finder, which cannot/)
  })

  it('a Return nobody can read names what the keyboard was last on and the key that moved it', () => {
    const held = { verb: 'keyboard', app: 'Zen', thing: { role: 'button', name: 'Archive' } }
    const unknown = finalOf('screen_act', { app: 'Zen', steps: [{ action: 'key', value: 'tab' }, { action: 'key', value: 'return' }] }, undefined, [held, key('Zen', 'tab'), key('Zen', 'return')])
    expect(unknown).toMatchObject({ kind: 'final-unknown', last: 'Archive', by: 'tab' })
    expect(finalAsk(unknown, { line: 'Key in Zen: tab; then key in Zen: return', window: 'Testbox' })).toBe('Gnomon: this Return in Zen (window "Testbox") lands on a part Gnomon cannot read for certain (the keyboard was last on "Archive", then tab moved it): what it presses may not be taken back, so it asks you first. Key in Zen: tab; then key in Zen: return · final: final-unknown')
  })

  it('the record keeps the bare kind: never the target, the window or what the keyboard was on (W3)', () => {
    const row = { verb: 'select', app: 'Finder', thing: { role: 'row', name: 'Testbox-old.log' } }
    const facts = callFacts({ toolName: 'screen_act', args: { app: 'Finder', action: 'key', value: 'cmd+backspace' }, plans: [row, key('Finder', 'cmd+backspace')] })
    expect(facts.final).toEqual({ kind: 'delete', via: 'screen', blind: false })
  })
})

describe('the Set 1 refusals: a known keyboard is no final-unknown (runs 150, 154, 155)', () => {
  it('run 150: cmd+t in a browser puts the keyboard in the address bar; the Return after typing opens what was typed', () => {
    const args = { app: 'Zen', steps: [{ action: 'key', value: 'cmd+t' }, { action: 'type', value: 'view-source:http://127.0.0.1:8793/' }, { action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', args)).toBeNull()
    expect(finalOf('screen_act', args, undefined, [key('Zen', 'cmd+t'), typed('Zen', 'view-source:http://127.0.0.1:8793/'), key('Zen', 'return')])).toBeNull()
    // cmd+t outside a browser (a Finder tab, the fonts panel) is not a field: it still asks, and says why.
    const finder = { app: 'Finder', steps: [{ action: 'key', value: 'cmd+t' }, { action: 'type', value: 'x' }, { action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', finder)).toMatchObject({ kind: 'final-unknown', by: 'cmd+t' })
  })

  it('run 154: cmd+n opens a new note with the keyboard in it; cmd+a selects in place and moves nothing', () => {
    const fresh = { app: 'Obsidian', steps: [{ app: 'Obsidian', action: 'key', value: 'cmd+n' }, { app: 'Obsidian', action: 'type', value: 'Gnomon job run160' }, { app: 'Obsidian', action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', fresh)).toBeNull()
    const rename = { app: 'Obsidian', steps: [{ app: 'Obsidian', action: 'key', value: 'cmd+a' }, { app: 'Obsidian', action: 'type', value: 'Gnomon job run160' }, { app: 'Obsidian', action: 'key', value: 'return' }, { app: 'Obsidian', action: 'type', value: 'Command: sleep 4' }] }
    expect(finalOf('screen_act', rename)).toBeNull()
    // The keyboard held on a Delete button: cmd+a leaves it there, so Return still presses it.
    const held = { verb: 'keyboard', app: 'Obsidian', thing: { role: 'button', name: 'Delete note' } }
    expect(finalOf('screen_act', { app: 'Obsidian', action: 'key', value: 'return' }, undefined, [held, key('Obsidian', 'cmd+a'), key('Obsidian', 'return')])).toMatchObject({ kind: 'delete', on: 'Delete note' })
    // Review (Set 2 R1): cmd+n is a field only in a browser or an editor. In Terminal, Mail or Finder nobody knows where the
    // keyboard lands (Terminal runs what is typed), so typing and Return there still ask.
    for (const app of ['Terminal', 'Mail', 'Finder']) {
      const args = { app, steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'rm -rf ~' }, { action: 'key', value: 'return' }] }
      expect(finalOf('screen_act', args), app).toMatchObject({ kind: 'final-unknown', by: 'cmd+n' })
      expect(finalOf('screen_act', { app, steps: [{ action: 'key', value: 'cmd+n' }, { action: 'key', value: 'return' }] }), app).toMatchObject({ kind: 'final-unknown' })
    }
    expect(decideAction({ toolName: 'screen_act', args: { app: 'Terminal', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'rm -rf ~' }, { action: 'key', value: 'return' }] }, preset: 'danger-full-access', actions, resolveActionPolicy, testMode: true, facts: callFacts({ toolName: 'screen_act', args: { app: 'Terminal', steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'rm -rf ~' }, { action: 'key', value: 'return' }] } }) })).toMatchObject({ kind: 'ask', reason: expect.stringMatching(/Return lands on a part Gnomon cannot read/) })
    for (const app of ['TextEdit', 'Notes', 'Pages', 'Zen']) expect(finalOf('screen_act', { app, steps: [{ action: 'key', value: 'cmd+n' }, { action: 'type', value: 'x' }, { action: 'key', value: 'return' }] }), app).toBeNull()
    // A tab after cmd+a still moves it.
    expect(finalOf('screen_act', { app: 'Obsidian', steps: [{ action: 'key', value: 'cmd+a' }, { action: 'key', value: 'tab' }, { action: 'key', value: 'return' }] })?.kind).toBe('final-unknown')
  })

  it('run 155: a click on a Finder name, cmd+a, the new name and Return is a rename, no final', () => {
    const args = { app: 'Finder', steps: [{ ref: 'e55@a63eb2', action: 'click' }, { action: 'key', value: 'cmd+a' }, { action: 'type', value: 'done-cobalt.txt' }, { action: 'key', value: 'return' }] }
    expect(finalOf('screen_act', args)).toBeNull()
    for (const role of ['text field', 'cell', 'row'])
      expect(finalOf('screen_act', args, undefined, [{ verb: 'click', app: 'Finder', thing: { role, name: 'cobalt.txt' } }, key('Finder', 'cmd+a'), typed('Finder', 'done-cobalt.txt'), key('Finder', 'return')]), role).toBeNull()
  })
})

describe('a shell ask carries its command verbatim and what it touches', () => {
  it('the command, cut at 200 characters, as written', () => {
    const command = `for i in 1 2 3 4 5 6; do echo "line $i"; sleep 4; done > /tmp/gnomon-job-run160.log`
    expect(commandLine(command)).toBe(`Command: ${command}`)
  })

  it('writes, deletes, reads, opens and reaches, from the whole command', () => {
    const cells = [
      [`for i in 1 2 3 4 5 6; do echo "line $i"; sleep 4; done > /tmp/gnomon-job-run160.log`, 'Touches: writes "/tmp/gnomon-job-run160.log"'],
      ['tail -n 1 /tmp/gnomon-job-run160.log 2>&1 >/dev/null', 'Touches: reads "/tmp/gnomon-job-run160.log"'],
      [`cat "$HOME/Documents/Kestrel/Gnomon job run160.md"`, 'Touches: reads "~/Documents/Kestrel/Gnomon job run160.md"'],
      ['curl -s http://127.0.0.1:8793/ | head -c 4000', 'Touches: reaches "http://127.0.0.1:8793"'],
      [`open 'obsidian://new?vault=Kestrel&file=Gnomon%20job%20run160&append=true&content=line%206'; sleep 3; cat "$HOME/Documents/Kestrel/Gnomon job run160.md"`, 'Touches: reads "~/Documents/Kestrel/Gnomon job run160.md"; opens "obsidian://new?vault=Kestrel&file=Gnomon job run160"'],
      ['rm -rf data/fix/old "/tmp/gnomon-run160/a b.log"', 'Touches: deletes "data/fix/old", "/tmp/gnomon-run160/a b.log"'],
      ['find /tmp/gnomon-run160 -name "*.log" -delete', 'Touches: deletes "/tmp/gnomon-run160"'],
      ['cp notes/a.txt /tmp/gnomon-run160/ && echo done | tee -a /tmp/gnomon-run160/log', 'Touches: writes "/tmp/gnomon-run160/", "/tmp/gnomon-run160/log"; reads "notes/a.txt"'],
      ['sqlite3 -readonly data/fix/rig.db "select count(*) from t"', 'Touches: reads "data/fix/rig.db"'],
      ['sqlite3 data/fix/rig.db "delete from t"', 'Touches: writes "data/fix/rig.db"'],
      // A here-document is input: the code in it touches nothing by itself, and a > inside quotes writes no file.
      [`python3 - <<'EOF'\nopen('/etc/hosts', 'w')\nEOF\necho "a > /tmp/x"`, null],
      ['URL=$(python3 -c "print(1)"); ls ~/Documents/Kestrel | grep -i run160', 'Touches: reads "~/Documents/Kestrel"'],
      ['pbpaste', null],
    ]
    for (const [command, line] of cells) expect(touchesLine(command), command).toBe(line)
    expect(touchesOf('date "+%H:%M:%S"')).toEqual({ writes: [], deletes: [], reads: [], opens: [], reaches: [] })
  })

  it('a relative path is named in the folder a cd before it moved to (run 211 T19)', () => {
    const cells = [
      // Run 211: "writes notes.txt" named no folder; the rig's yes could not read where it lands and said no.
      [`cd "/tmp/gnomon-run211/Testbox-wall" && ls -l notes.txt && printf 'Kestrel\\n' >> notes.txt && tail -n 3 notes.txt`, 'Touches: writes "/tmp/gnomon-run211/Testbox-wall/notes.txt"; reads "/tmp/gnomon-run211/Testbox-wall"'],
      ['cd ~/Documents/Kestrel; cp notes.txt "notes copy.txt"; rm old/a.log', 'Touches: writes "~/Documents/Kestrel/notes copy.txt"; deletes "~/Documents/Kestrel/old/a.log"; reads "~/Documents/Kestrel"'],
      ['cd /tmp/gnomon-run211 && cd sub && echo x > ../y.txt', 'Touches: writes "/tmp/gnomon-run211/y.txt"; reads "/tmp/gnomon-run211"'],
      // A cd inside a subshell holds only to its end; after an unknown cd a path stays as written.
      ['(cd /tmp/gnomon-run211 && touch a.txt); echo x > b.txt', 'Touches: writes "/tmp/gnomon-run211/a.txt", "b.txt"; reads "/tmp/gnomon-run211"'],
      ['cd "$DIR" && echo x > notes.txt', 'Touches: writes "notes.txt"'],
      ['cd /tmp/gnomon-run211 x && echo x > notes.txt', 'Touches: writes "notes.txt"; reads "/tmp/gnomon-run211"'],
    ]
    for (const [command, line] of cells) expect(touchesLine(command), command).toBe(line)
  })

  it('a shell final carries the same line before its command', () => {
    const command = 'rm /tmp/gnomon-run160/old.log'
    expect(finalAsk(finalOf('gnomon_run_shell', { command }), { command })).toBe('Gnomon: this deletes "/tmp/gnomon-run160/old.log" from the shell, which cannot be taken back, so it asks you first. · Path: /tmp/gnomon-run160/old.log · Touches: deletes "/tmp/gnomon-run160/old.log" · Command: rm /tmp/gnomon-run160/old.log · final: delete')
  })
})
