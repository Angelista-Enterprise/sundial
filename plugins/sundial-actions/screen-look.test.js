import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sanitizeAtIngest } from '@sundial/helpers/sanitize-at-ingest.js'
import { ALLOWED, lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { createInitialState } from '../../packages/kernel/src/initial-state.ts'
import { markTrack } from '../../packages/rules/src/mark-track.ts'
import { MAX, actionFor, again, carry, deadEndsOf, diff, format, learned, line, listed, lookOf, prune, rank, resolve, routesOf, stepText, stuckMenu, textLines, verbs } from './screen-look.js'

/** One line as Sundial.app writes it (doc 16, B2), with made-up values. */
// Notes is private by name since 2026-11-17 (privateAppName): the sample look is read as a Pages window.
const LINE = readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages')
/** The line as the log holds it: let in, renamed for the redaction pass, sanitized. */
function logged(change = {}) {
  const { type, at, ...payload } = { ...JSON.parse(LINE), ...change }
  expect(ALLOWED.test(type)).toBe(true)
  return sanitizeAtIngest({ id: 'ev-1', type, ts: at, payload: lookForLog(payload) })
}
const el = (ref, role, label, frame, more = {}) => ({ ref, role, sub: '', label, value: '', frame, actions: [], settable: false, enabled: true, in: '', ...more })

describe('one look, from the app to the model (doc 16)', () => {
  it('the sample line: let in, folded to a pointer, formatted, and diffed against the next look', () => {
    const event = logged()
    const { state } = markTrack(createInitialState('d1'), event)
    expect(state.marks?.lastLook).toEqual({ id: 'look-1a2b3c4d', app: 'Pages', window: 'Lunch Thursday', n: 4, at: event.ts, after: 'act-9f8e7d6c' })
    expect(JSON.stringify(state)).not.toContain('Mira Bakker')

    const look = lookOf(event.payload)
    expect(look.bundleId).toBe('com.example.notes')
    expect(format(look)).toBe(
      [
        'Pages, window "Lunch Thursday": 4 things, keyboard in e7@3c4d.',
        'in toolbar:',
        'e1@3c4d button "New Note"',
        'e7@3c4d search field "Search" = "" [confirm]',
        'in Pages:',
        'e9@3c4d row "Mira Bakker, Lunch Thursday, 09:12"',
        'in ocr:',
        't1@3c4d text "Call puzzlebox-studio about BOX-484"',
        'menus: File, Edit, Format, View, Window, Help',
      ].join('\n'),
    )

    const [, search, row, text] = JSON.parse(LINE).elements
    const next = lookOf(logged({ id: 'look-2', window: 'Lunch Friday', focused: 'e12', elements: [{ ...search, ref: 'e3', value: 'lunch' }, row, text, el('e12', 'AXButton', 'Done', [700, 58, 40, 24], { actions: ['AXPress'] })] }).payload)
    expect(diff(look, next)).toBe(['window: now "Lunch Friday"', 'focus: e12@ok-2 button "Done"', 'appeared: e12@ok-2 button "Done"', 'gone: button "New Note"', 'changed: e3@ok-2 search field "Search" = "lunch"'].join('\n'))
    expect(diff(look, look)).toBe('Nothing on screen changed.')
    expect(diff(null, look)).toBe('')
    // What the step brought comes first in the text of the look after it.
    expect(format(next, { before: look, budget: 2 }).split('\n').filter((l) => /^e\d/.test(l)).map((l) => l.split(' ')[0])).toEqual(['e3@ok-2', 'e12@ok-2'])
    // A query puts what it names first and keeps the rest after it, never drops it.
    const refs = format(next, { query: 'done' }).split('\n').filter((l) => /^e\d/.test(l)).map((l) => l.split(' ')[0])
    expect(refs[0]).toBe('e12@ok-2')
    expect(refs.length).toBe(format(next).split('\n').filter((l) => /^e\d/.test(l)).length)
  })

  it('a private or hidden app keeps no word in the log, and its look is a refusal', () => {
    const event = logged({ app: 'Mail' })
    expect(JSON.stringify(event.payload)).not.toMatch(/Mira|Lunch|"Search"|BOX-484|File/)
    expect(event.payload.elements[2].screenText).toEqual(['[private]', '[private]', '[private]'])
    expect(markTrack(createInitialState('d1'), event).state.marks?.lastLook).toMatchObject({ id: 'look-1a2b3c4d', refused: 'private app' })
    const hidden = { ...event, payload: { ...event.payload, processName: '[hidden]' } }
    expect(markTrack(createInitialState('d1'), hidden).state.marks?.lastLook).toMatchObject({ app: '[hidden]', refused: 'private app' })
  })

  it('the app\'s other windows are named, with how to reach one; a private app\'s titles blank like its title', () => {
    const windows = [{ title: 'Lunch Thursday', main: true, minimized: false }, { title: 'puzzlebox-studio - Pages', main: false, minimized: true }, { title: 'BOX-484', main: false, minimized: false }]
    const look = lookOf(logged({ windows }).payload)
    expect(look.windows[1]).toEqual({ title: 'puzzlebox-studio - Pages', main: false, minimized: true })
    expect(format(look).split('\n')[1]).toBe('Other windows: "puzzlebox-studio - Pages" (minimized), "BOX-484".')
    expect(logged({ app: 'Mail', windows }).payload.windows.map((w) => w.windowTitle)).toEqual(['[private]', '[private]', '[private]'])
    expect(format(lookOf(logged().payload))).not.toContain('Other windows')
  })

  it('a refusal from the app folds as one', () => {
    const { state } = markTrack(createInitialState('d1'), logged({ app: undefined, window: undefined, elements: undefined, menus: undefined, refused: 'secure input' }))
    expect(state.marks?.lastLook).toMatchObject({ id: 'look-1a2b3c4d', n: 0, refused: 'secure input' })
  })
})

describe('the pure parts', () => {
  const look = lookOf(logged().payload)

  it('a web part Firefox calls AXUnknown reads by its role, never as "unknown" (runs 49, 56, 60)', () => {
    const page = { id: 'look-z', app: 'Zen', window: 'Order', elements: [el('e1', 'AXStaticText', 'Shipping', [10, 10, 60, 14], { sub: 'AXUnknown' }), el('e2', 'AXGroup', 'Gift wrap', [10, 30, 90, 14], { sub: 'AXUnknown', actions: ['AXPress'] }), el('e3', 'AXTextField', 'Name', [80, 10, 160, 20], { settable: true })] }
    expect(format(page).split('\n').slice(1)).toEqual(['e1@ok-z text "Shipping"', 'e2@ok-z group "Gift wrap"', 'e3@ok-z field "Name" = ""'])
    expect(resolve(page, { role: 'group', label: 'Gift wrap' })?.ref).toBe('e2')
  })

  it('a form\'s label text and wrapper group give way to the field of the same words (run 67 T05)', () => {
    const web = { sub: 'AXUnknown', in: 'Order form', actions: ['AXPress'] }
    const page = { id: 'look-f', app: 'Zen', window: 'Order form', elements: [
      el('e1', 'AXGroup', 'Name', [48, 196, 246, 24], web),
      el('e2', 'AXStaticText', '', [48, 196, 57, 24], { ...web, value: 'Name' }),
      el('e3', 'AXTextField', 'Name', [105, 199, 189, 22], { in: 'Order form', settable: true }),
      el('e4', 'AXStaticText', '', [48, 241, 42, 24], { ...web, value: 'Size' }),
      el('e5', 'AXPopUpButton', '', [90, 245, 80, 22], { in: 'Order form', value: 'Small', actions: ['AXPress'] }),
      el('e6', 'AXGroup', 'Gift wrap', [48, 287, 107, 24], web),
      el('e7', 'AXCheckBox', 'Gift wrap', [52, 293, 14, 14], { in: 'Order form', value: '0', actions: ['AXPress'] }),
      el('e8', 'AXStaticText', '', [69, 287, 86, 24], { ...web, value: 'gift  wrap ' }),
      el('e9', 'AXStaticText', 'Name', [48, 400, 60, 14], { in: 'Footer' }),
      el('e10', 'AXStaticText', 'Agree', [48, 330, 60, 14], { in: 'Order form' }),
      el('e11', 'AXCheckBox', 'Agree', [110, 330, 14, 14], { in: 'Order form', value: '0', actions: ['AXPress'] }),
      el('e12', 'AXStaticText', 'Submit', [48, 360, 60, 14], { in: 'Order form' }),
      el('e13', 'AXStaticText', '7', [48, 380, 60, 14], { in: 'Order form' }),
      el('e14', 'AXButton', '7', [110, 380, 30, 30], { in: 'Order form', actions: ['AXPress'] }),
      el('e15', 'AXButton', 'Submit', [48, 420, 60, 22], { in: 'Order form', actions: ['AXPress'] }),
    ] }
    // A check box or button takes only the text right before it; a text after it, one elsewhere in its place, or digits stay.
    expect(prune(page.elements).map((e) => e.ref)).toEqual(['e3', 'e4', 'e5', 'e7', 'e8', 'e9', 'e11', 'e12', 'e13', 'e14', 'e15'])
    // A text right before its field in the tree is its label, in another place too.
    expect(prune([el('e1', 'AXStaticText', 'Email', [0, 0, 40, 14], { in: 'Card' }), el('e2', 'AXTextField', 'Email', [50, 0, 100, 20], { in: 'Form', settable: true })]).map((e) => e.ref)).toEqual(['e2'])
  })

  it('a menu item the app marks keeps its mark through the log, and its line shows it (runs 42, 50, 57)', () => {
    const item = (ref, label, more) => ({ ref, role: 'AXMenuItem', sub: '', label, value: '', frame: [184, 45, 262, 24], actions: ['AXPress'], settable: false, enabled: true, in: 'View', ...more })
    const menu = lookOf(logged({ elements: [item('e1', 'as Icons'), item('e2', 'as List', { checked: true }), item('e3', 'Sort By', { submenu: true }), item('e4', 'Go to Folder…', { keys: '⇧⌘G' })] }).payload)
    const lines = format(menu).split('\n')
    expect(lines).toContain('e1@3c4d menu item "as Icons"')
    expect(lines).toContain('e2@3c4d menu item "as List" ✓')
    expect(lines).toContain('e3@3c4d menu item "Sort By" ›')
    expect(lines).toContain('e4@3c4d menu item "Go to Folder…" ⇧⌘G')
  })

  it('diff: two things alike are told apart by their place in the look, and the keyboard is named only where the look holds it', () => {
    const box = (ref, value) => el(ref, 'AXTextField', '', null, { settable: true, value })
    const [was, now] = [{ id: 'look-a', app: 'Pages', window: '', elements: [box('e1', ''), box('e2', '')] }, { id: 'look-b', app: 'Pages', window: '', focused: 'e9', elements: [box('e1', ''), box('e2', 'BOX-484')] }]
    expect(diff(was, now)).toBe('changed: e2@ok-b field = "BOX-484"')
    expect(format(now).split('\n')[0]).toBe('Pages, window "": 2 things.')
  })

  it('carry: a ref from an older look is the thing with the same role, words and place in the newest; gone or a changed count of alike is none', () => {
    const play = (ref, frame, more) => el(ref, 'AXButton', 'Play', frame, { actions: ['AXPress'], in: 'player', ...more })
    const was = { elements: [el('e1', 'AXStaticText', 'Moanin', [0, 0, 80, 14], { in: 'queue' }), play('e2', [0, 20, 30, 30]), el('e3', 'AXButton', 'Like', [40, 20, 30, 30], { actions: ['AXPress'], in: 'player' })] }
    // The list above grew by two rows: every eN moved.
    const now = { elements: [el('e1', 'AXStaticText', 'Blue Train', [0, 0, 80, 14], { in: 'queue' }), el('e2', 'AXStaticText', 'So What', [0, 14, 80, 14], { in: 'queue' }), el('e3', 'AXStaticText', 'Moanin', [0, 28, 80, 14], { in: 'queue' }), play('e4', [0, 48, 30, 30]), el('e5', 'AXButton', 'Like', [40, 48, 30, 30], { actions: ['AXPress'], in: 'player' })] }
    expect(carry(was, now, 'e2')?.ref).toBe('e4')
    expect(carry(was, now, 'e1')?.ref).toBe('e3')
    expect(carry(was, now, 'e9')).toBeNull()
    expect(carry(was, { elements: now.elements.filter((e) => e.label !== 'Like') }, 'e3')).toBeNull()
    // Two alike where there was one: which one is a guess.
    expect(carry(was, { elements: [...now.elements, play('e6', [0, 90, 30, 30])] }, 'e2')).toBeNull()
    // The same words in another place are another thing.
    expect(carry(was, { elements: [play('e7', [0, 0, 30, 30], { in: 'sidebar' })] }, 'e2')).toBeNull()
  })

  it('resolve: a name points at one thing of the look, by its words and a role that fits; none or two is no answer', () => {
    const things = [el('e1', 'AXTextField', 'Search the handbook', [0, 0, 200, 20], { sub: 'AXSearchField', settable: true }), el('e2', 'AXButton', 'New Note', [0, 30, 60, 20], { actions: ['AXPress'] }), el('e3', 'AXButton', 'Share', [0, 60, 60, 20], { actions: ['AXPress'] }), el('e4', 'AXMenuItem', 'Share', [0, 90, 60, 20], { actions: ['AXPress'] })]
    const look = { elements: things }
    for (const role of ['search field', 'text field', 'AXTextField', 'field', 'searchfield']) expect(resolve(look, { role, label: 'search the handbook' })?.ref).toBe('e1')
    expect(resolve(look, { label: 'Share' })).toBeNull()
    expect(resolve(look, { role: 'menuitem', label: 'Share' })?.ref).toBe('e4')
    // A role given that fits nothing is no answer here: the by-name path decides, and can say not-found.
    expect(resolve(look, { role: 'menu item', label: 'New Note' })).toBeNull()
    expect(resolve(look, { text: 'New Note' })?.ref).toBe('e2')
    expect(resolve(look, { role: 'button', label: 'Settings' })).toBeNull()
    expect(resolve(look, { role: 'button' })).toBeNull()
    expect(resolve(null, { label: 'Share' })).toBeNull()
  })

  it('lookOf: no row is no look', () => {
    expect(lookOf(null)).toBeNull()
    expect(look.elements[1]).toMatchObject({ ref: 'e7', label: 'Search', value: '', in: 'toolbar' })
  })

  it('verbs: the element\'s own action names, set-value and focus when it takes a value, click when it offers nothing', () => {
    expect(verbs({ actions: ['AXPress', 'AXShowMenu'] })).toEqual(['press'])
    expect(verbs({ settable: true, actions: ['AXConfirm'] })).toEqual(['set-value', 'focus', 'confirm'])
    expect(verbs({ actions: [] })).toEqual(['click'])
    // Chromium gives every node show-menu and scroll-to-visible: they stay only on a control with nothing else.
    expect(verbs({ role: 'AXLink', actions: ['AXPress', 'AXShowMenu', 'AXScrollToVisible'] })).toEqual(['press'])
    expect(verbs({ role: 'AXStaticText', actions: ['AXShowMenu', 'AXScrollToVisible'] })).toEqual(['click'])
    expect(verbs({ role: 'AXButton', sub: '', actions: ['AXShowMenu', 'AXScrollToVisible'] })).toEqual(['show-menu', 'scroll-to-visible'])
    // Electron's wrapper group says it takes a value; with no words and no value it does not.
    expect(verbs({ role: 'AXGroup', settable: true, actions: [] })).toEqual(['click'])
    expect(verbs({ role: 'AXGroup', settable: true, label: 'Rename', actions: [] })).toEqual(['set-value', 'focus'])
    expect(actionFor({ actions: ['AXShowMenu', 'AXScrollToVisible'] }, 'show-menu')).toBe('AXShowMenu')
    expect(actionFor({ actions: ['AXShowMenu'] }, 'show-menu')).toBe('AXShowMenu')
    expect(actionFor({ actions: [] }, 'key')).toBe('key')
    expect(actionFor({ actions: ['AXPress'] }, 'raise')).toBeUndefined()
  })

  it('prune: drops what says and does nothing, folds a row into its one child, drops doubles', () => {
    const out = prune([
      el('e1', 'AXGroup', '', [0, 0, 400, 300]),
      el('e2', 'AXRow', '', [0, 40, 400, 20], { actions: ['AXPress'] }),
      el('e3', 'AXStaticText', 'Mira Bakker', [4, 42, 120, 16]),
      el('e4', 'AXButton', 'Send', [300, 100, 60, 24], { actions: ['AXPress'] }),
      el('t1', 'text', 'send', [310, 104, 40, 14]),
      el('e5', 'AXRow', 'Two things', [0, 140, 400, 20]),
      el('e6', 'AXStaticText', 'One', [4, 142, 40, 16]),
      el('e7', 'AXStaticText', 'Two', [60, 142, 40, 16]),
    ])
    expect(out.map((e) => `${e.ref} ${e.label}`)).toEqual(['e2 Mira Bakker', 'e4 Send', 'e5 Two things', 'e6 One', 'e7 Two'])
  })

  it('prune: a table cell whose only child repeats its words drops that child, so a 6-row table fits one look (run 36 T04)', () => {
    const items = [['Item', 'Stock', 'Price'], ['Kettle', '12', '40'], ['Lamp', '7', '25'], ['Rope', '30', '8'], ['Spoon', '55', '3'], ['Tent', '4', '90'], ['Vase', '9', '18']]
    const table = (n) => items.flatMap((row, r) => [
      el(`r${n}${r}`, 'AXRow', row.join(', '), [50, 200 + r * 40, 240, 40]),
      ...row.flatMap((word, c) => [el(`c${n}${r}${c}`, 'AXCell', word, [50 + c * 80, 200 + r * 40, 80, 40]), el(`u${n}${r}${c}`, 'AXStaticText', '', [60 + c * 80, 208 + r * 40, 40, 24], { sub: 'AXUnknown', value: word })]),
    ])
    // The browser hands the table over twice: the same cells at the same spots.
    const elements = [el('w1', 'AXWebArea', 'Stock list', [0, 80, 1400, 900]), ...table(1), ...table(2)]
    const out = prune(elements)
    expect(out.filter((e) => e.ref.startsWith('u'))).toEqual([])
    expect(out.filter((e) => /Row|Cell/.test(e.role))).toHaveLength(7 * 4)
    const text = format({ app: 'Zen', window: 'Stock list', id: 'look-0000abcd', elements })
    expect(text).toContain('row "Vase, 9, 18"')
    expect(text).not.toMatch(/more not shown/)
    // A child with other words than its cell: they are kept (on the cell, as the one-child fold always did; beside a copy, as itself).
    expect(prune([el('c1', 'AXCell', 'Lamp', [0, 0, 80, 40]), el('u1', 'AXStaticText', '', [4, 4, 40, 20], { value: 'on sale' })])).toMatchObject([{ ref: 'c1', label: 'Lamp', value: 'on sale' }])
    const copied = [el('c1', 'AXCell', 'Lamp', [0, 0, 80, 40]), el('u1', 'AXStaticText', '', [4, 4, 40, 20], { value: 'on sale' }), el('c2', 'AXCell', 'Lamp', [0, 0, 80, 40]), el('u2', 'AXStaticText', '', [4, 4, 40, 20], { value: 'on sale' })]
    expect(prune(copied).map((e) => e.ref)).toContain('u1')
  })

  it('rank: the query\'s words in the label, the role and the place; no query keeps the order', () => {
    expect(rank(look.elements, 'the search field').map((e) => e.ref)).toEqual(['e7'])
    expect(rank(look.elements, 'toolbar button').map((e) => e.ref)).toEqual(['e1', 'e7'])
    expect(rank(look.elements, 'spreadsheet')).toEqual([])
    // Fourteen rows with the same words are three rows and a count (run 12).
    const many = { ...look, elements: [...look.elements, ...Array.from({ length: 14 }, (_, i) => ({ ref: `x${i}`, role: 'AXButton', label: 'Add to Liked Songs', actions: ['AXPress'] }))] }
    const out = format(many)
    expect(out.split('\n').filter((l) => /Add to Liked Songs/.test(l) && /^e|^x/.test(l))).toHaveLength(3)
    expect(out).toContain('14 things say "add to liked songs"')
    // What the app says about the window itself, so the model does not act behind a dialog or into a hidden window.
    expect(format({ ...look, front: false, dialog: true }).split('\n').slice(1, 3)).toEqual([
      'Pages is NOT in front: this window is behind another app\'s. Bring it up (screen_act {app}) before a step, or the owner sees nothing happen.',
      'A dialog or sheet holds the keyboard: answer or close it first (its buttons are in this list), because nothing behind it can be used.',
    ])
    expect(format(look)).not.toContain('NOT in front')
    // The window title is the place of every part: its words alone match nothing (run 11).
    const parts = [{ ref: 'a', role: 'AXGroup', label: 'Note title', in: 'Lunch - Vault' }, { ref: 'b', role: 'AXRow', label: 'Lunch plans', in: 'Lunch - Vault' }]
    expect(rank(parts, 'lunch', 'Lunch - Vault').map((e) => e.ref)).toEqual(['b'])
    // A rare word outweighs a word many parts hold: "play" is on every sidebar button, "supreme" on one.
    const sidebar = ['Daily Mix', 'Focus', 'Chill'].map((name, i) => ({ ref: `p${i}`, role: 'AXButton', label: `Play ${name}` }))
    expect(rank([...sidebar, { ref: 't1', role: 'AXButton', label: 'Play A Love Supreme' }], 'play love supreme')[0].ref).toBe('t1')
    expect(rank(look.elements, '')).toBe(look.elements)
    expect(rank([el('e1', 'AXTextField', 'To', null, { value: 'Mira Bakker' })], 'mira').map((e) => e.ref)).toEqual(['e1'])
  })

  it('textLines: the screen-text lines that hold half the query or more, most words first; a private row has none', () => {
    const text = 'Play\nAdd to queue\nGo to album\nShare with Mira Bakker\nAdd to queue\nQueue'
    expect(textLines(text, 'add to queue')).toEqual(['Add to queue'])
    expect(textLines(text, 'the queue')).toEqual(['Add to queue', 'Queue'])
    expect(textLines(text, 'spreadsheet')).toEqual([])
    expect(textLines('[private]', 'private')).toEqual([])
    expect(textLines(undefined, 'play')).toEqual([])
  })

  it('format: the matches first, a budget, and how to ask for the rest', () => {
    expect(format(look, { query: 'lunch' }).split('\n').slice(1, 3)).toEqual(['in Pages:', 'e9@3c4d row "Mira Bakker, Lunch Thursday, 09:12"'])
    expect(format(look, { query: 'spreadsheet' })).toContain('Nothing matches "spreadsheet". The top of the window:')
    const cut = format({ ...look, truncated: true, ocr: 'no grant' }, { budget: 2 }).split('\n')
    expect(cut.filter((l) => /^[et]\d+@/.test(l))).toHaveLength(2)
    expect(cut.slice(-3)).toEqual(['2 more not shown: look again with query, a few words of what you look for.', 'The window holds more than one look takes: look again with query, or name the window.', 'Text inside pictures was not read: Screen Recording is not granted.'])
    // A look that had a query is not told to look again with one: it is told where the matches are.
    // A look cut by the clock (fewer things than the look's max) read no further for the query: that clause is left out.
    expect(format({ ...look, truncated: true }, { query: 'lunch', budget: 2 }).split('\n').slice(-2)).toEqual(['2 more not shown, none of them match "lunch".', 'The window holds more than one look reads. For something else: other words, or name the window.'])
    const full = { ...look, truncated: true, elements: Array.from({ length: MAX }, (_, i) => el(`e${i}`, 'AXButton', `Thing ${i}`, [i, 0, 1, 1], { actions: ['AXPress'] })) }
    expect(format(full, { query: 'thing 7' })).toContain('The window holds more than one look reads; the app read further for the words of "thing 7", and what it found is listed first. For something else: other words, or name the window.')
    expect(format(look, { query: 'search field button', budget: 1 })).toContain('3 more not shown, 1 of them match "search field button": fewer, rarer words narrow it.')
  })

  // A made-up Finder: 40 sidebar places, then a folder's 5 files.
  const finder = (more = []) => ({
    app: 'Finder',
    window: 'sizes',
    id: 'look-0000f1d0',
    elements: [
      ...Array.from({ length: 40 }, (_, i) => el(`s${i}`, 'AXRow', `Place ${i}`, [0, i * 20, 150, 20], { actions: ['AXPress'], in: 'sidebar' })),
      ...['marlin', 'cobalt', 'quartz', 'willow', 'tamarind'].map((n, i) => el(`f${i}`, 'AXTextField', `${n}.txt`, [200, i * 20, 150, 20], { in: 'list' })),
      ...more,
    ],
  })
  it('format: a query that matches nothing lists the window\'s own parts before the sidebar (run 42 T07)', () => {
    const files = format(finder(), { query: 'files in sizes folder', budget: 20 }).split('\n').filter((l) => /^f\d@/.test(l))
    expect(files).toHaveLength(5)
    // A toolbar holds main controls (Finder's view popup): it keeps its place in the tree.
    const bar = finder()
    bar.elements.unshift(el('v1', 'AXPopUpButton', 'View', [0, 0, 40, 20], { actions: ['AXPress'], in: 'toolbar' }))
    expect(format(bar, { query: 'files in sizes folder', budget: 20 }).split('\n').filter((l) => /^[vfs]\d+@/.test(l))[0]).toMatch(/^v1@/)
    // Run 48 T05: a browser's tabs in its sidebar are tab buttons, and keep their place too.
    const tabs = finder()
    tabs.elements.unshift(el('t1', 'AXRadioButton', 'Hourglass - Wikipedia', [0, 0, 150, 20], { sub: 'AXTabButton', actions: ['AXPress'], in: 'sidebar' }))
    expect(format(tabs, { query: 'files in sizes folder', budget: 20 }).split('\n').filter((l) => /^[tfs]\d+@/.test(l))[0]).toMatch(/^t1@/)
  })
  it('format: hidden file names past the cut are not called "none of them match" (run 42 T07)', () => {
    expect(format(finder(), { query: '3', budget: 1 })).toContain('more not shown (names and rows among them): ask with a word from their names, or no query.')
    // Only sidebar parts hidden: the old words.
    const sidebar = { ...finder(), elements: finder().elements.filter((e) => e.in === 'sidebar') }
    expect(format(sidebar, { query: '3', budget: 1 })).toMatch(/\d+ more not shown, none of them match "3"\.$/m)
  })
  it('format: a window in column view says it holds no size (run 42 T07)', () => {
    const say = 'This window is in column view: it lists names only, no size, date or kind. For those, switch to list view (View > as List, or cmd+2) or read the folder from the shell.'
    expect(format(finder([el('b1', 'AXBrowser', '', [200, 0, 600, 400])])).split('\n')[1]).toBe(say)
    expect(format(finder([el('f9', 'AXTextField', 'tamarind.md', [200, 100, 150, 20], { in: 'column view' })]))).toContain(say)
    expect(format(finder())).not.toContain('column view')
    // Another app: no Finder menu or key to name.
    expect(format({ ...finder([el('b1', 'AXBrowser', '', [200, 0, 600, 400])]), app: 'Cobalt' }).split('\n')[1]).toBe('This window is in column view: names only, no size, date or kind.')
  })
  it('stuckMenu: the same menu open before and after an escape says to close it (run 42 T07)', () => {
    const say = 'A menu is still open from an earlier step: close it first (key escape; if it stays open, press its menu bar item again).'
    const menu = (place) => ['as Icons', 'as List', 'as Columns'].map((l, i) => el(`m${i}`, 'AXMenuItem', l, [300, i * 20, 120, 20], { actions: ['AXPress'], in: place }))
    const open = (place) => ({ ...finder(menu(place)), menus: ['File', 'View'] })
    const [was, now] = [{ ...open('View'), id: 'look-0000aaaa' }, open('View')]
    expect(stuckMenu(now, was)).toBe(say)
    expect(stuckMenu({ ...open('menu'), id: 'look-0000bbbb' }, open('menu'))).toBe(say)
    expect(stuckMenu(now, { ...finder(), menus: ['File', 'View'] })).toBe('')
    expect(stuckMenu(now, { ...was, app: 'Pages' })).toBe('')
    expect(stuckMenu(now, now)).toBe('')
    expect(stuckMenu(now, undefined)).toBe('')
    // A page's own menuitems (a web app's menubar) are not an open menu of the app.
    expect(stuckMenu({ ...open('page'), id: 'look-0000cccc' }, open('page'))).toBe('')
    expect(format(now)).not.toContain(say)
  })

  it('format: a match counted as alike is not counted again as a match past the cut', () => {
    const plays = Array.from({ length: 8 }, (_, i) => el(`p${i}`, 'AXButton', 'Play', [i * 10, 0, 8, 8], { actions: ['AXPress'] }))
    const rest = ['Home', 'Search', 'Library'].map((label, i) => el(`r${i}`, 'AXButton', label, [0, 20 + i * 10, 8, 8], { actions: ['AXPress'] }))
    const out = format({ app: 'Spotify', window: 'Spotify', id: 'look-00000001', elements: [...plays, ...rest] }, { query: 'play', budget: 2 })
    // Eight "Play": three listed, five counted as alike; of the three, two fit the budget and one is past it.
    expect(out).toContain('8 things say "play"')
    expect(out).toContain('4 more not shown, 1 of them match "play": fewer, rarer words narrow it.')
  })
  it('again: a look that repeats the last one, nothing done since, answers with what changed and the matches not listed before', () => {
    const was = lookOf(logged().payload)
    const known = listed(was, { query: 'search' })
    const now = { ...was, id: 'look-5e6f7a8b', elements: [...was.elements, el('e12', 'AXButton', 'Share', [460, 58, 28, 24], { actions: ['AXPress'], in: 'toolbar' })] }
    const head = (id, wasId) => `Pages, window "Lunch Thursday": the window of your last look, with nothing done since. Its refs still work; only what is new to you is listed.`
    const first = again(now, was, { query: 'share', known })
    expect(first.text).toBe([head('look-5e6f7a8b', 'look-1a2b3c4d'), 'What changed:', 'appeared: e12@7a8b button "Share"', 'Matching "share", not listed before:', 'in toolbar:', 'e12@7a8b button "Share"'].join('\n'))
    // What it printed, and nothing else, becomes known.
    expect([...first.listed]).toEqual(['button "Share" in "toolbar"'])
    // Already listed: said once, so the model stops asking for it in other words.
    // Run 36 T04: every thing of a look not cut off already listed: nothing more is hidden, and no "scroll it".
    expect(again(now, now, { query: 'new note', known: new Set([...known, ...first.listed]) }).text).toBe([head('look-5e6f7a8b', 'look-5e6f7a8b'), 'Nothing on screen changed.', 'Nothing matching "new note" is new, and nothing more is hidden: every thing in this window is in the lines you already have.'].join('\n'))
    // Some of it never listed, or a look cut off: the old words.
    expect(again(now, now, { query: 'new note', known }).text).toContain('or not in this window (scroll it, or name another window).')
    expect(again({ ...was, truncated: true }, was, { query: 'new note', known }).text).toContain('(scroll it, or name another window)')
  })

  it('again: the window\'s state lines come along; a cut look keeps the values that changed and drops what appeared or went', () => {
    const was = lookOf(logged().payload)
    const known = listed(was, {})
    // The owner opened a sheet, moved to another app and opened a second window, with no step of Gnomon's between.
    const moved = again({ ...was, id: 'look-5e6f7a8b', front: false, dialog: true, windows: [{ title: 'Lunch Thursday' }, { title: 'Groceries' }] }, was, { query: 'share', known }).text.split('\n')
    expect(moved.slice(1, 4)).toEqual([
      'Pages is NOT in front: this window is behind another app\'s. Bring it up (screen_act {app}) before a step, or the owner sees nothing happen.',
      'A dialog or sheet holds the keyboard: answer or close it first (its buttons are in this list), because nothing behind it can be used.',
      'Other windows: "Groceries".',
    ])
    // The same windows as before: not said again.
    expect(again({ ...was, id: 'look-5e6f7a8b' }, was, { query: 'share', known }).text).not.toContain('Other windows')
    // Both cut short: the owner's typing in the search field shows, the part only one of them holds does not.
    const typed = { ...was, id: 'look-5e6f7a8b', truncated: true, elements: [...was.elements.map((e) => (e.ref === 'e7' ? { ...e, value: 'lunch' } : e)), el('e12', 'AXButton', 'Share', [460, 58, 28, 24], { actions: ['AXPress'] })] }
    const cut = again(typed, { ...was, truncated: true }, { query: 'share', known }).text
    expect(cut).toContain('What changed:\nchanged: e7@7a8b search field "Search" = "lunch"')
    expect(cut).not.toMatch(/appeared|gone/)
    expect(again({ ...typed, elements: was.elements }, { ...was, truncated: true }, { query: 'share', known }).text).toContain('No value changed on the things both looks hold.')
  })
})

describe('routes: what worked in one app, from its screen:step rows', () => {
  let n = 0
  const step = (session, goal, verb, role, name, more = {}) => ({ at: `2026-11-10T09:${String(n++).padStart(2, '0')}:00Z`, processName: 'Spotify', verb, role, screenText: [name, goal], session, ok: true, ...more })

  it('per goal, the steps of the latest run that ended on a changed screen, a repeat once; no goal groups by session', () => {
    n = 0
    const rows = [
      step('s1', 'search a song', 'open', undefined, ''),
      step('s1', 'search a song', 'press', 'button', 'Search'),
      step('s1', 'search a song', 'press', 'button', 'Search'),
      step('s1', 'search a song', 'type', 'search field', 'What do you want to play?', { typed: 9, changed: true }),
      step('s2', 'search a song', 'press', 'button', 'Home', { changed: false }),
      step('s2', '', 'key', undefined, '', { key: 'space', changed: true }),
      step('s3', 'like a song', 'press', 'button', 'Like', { ok: false, reason: 'not-found' }),
    ]
    const routes = routesOf(rows)
    expect(routes.map((r) => [r.goal, r.steps.map(stepText).join(' → ')])).toEqual([
      [null, 'key "space"'],
      ['search a song', 'open → press {role: "button", label: "Search"} → type {role: "search field", label: "What do you want to play?"} (a value, 9 characters)'],
    ])
    expect(deadEndsOf(rows).map(stepText)).toEqual(['press {role: "button", label: "Like"}'])
    expect(deadEndsOf([...rows, step('s4', 'like a song', 'press', 'button', 'Like')])).toEqual([])
  })

  it('a run is a route only when its last step changed the screen: a private app\'s run never is, its dead ends still show', () => {
    n = 0
    const rows = [step('s1', '[private]', 'press', 'button', '[private]'), step('s1', '[private]', 'type', 'text field', '[private]', { typed: 20 })]
    expect(routesOf(rows)).toEqual([])
    expect(learned(rows, 'Mail')).toBe('')
    const blind = [
      { ...step('s2', '', 'set-value', 'text field', '[private]', { ok: false, reason: 'not-found' }), screenText: ['[private]'], goal: 'send a mail' },
      { ...step('s2', '', 'set-value', 'text field', '[private]', { ok: false, reason: 'not-found' }), screenText: ['[private]'], goal: 'send a mail' },
      { ...step('s2', '', 'key', undefined, '', { key: 'tab' }), screenText: [''], goal: 'send a mail' },
    ]
    expect(learned(blind, 'Mail')).toBe('Did not work here: set-value {role: "text field"} (its name is off the record) (not-found, 2 times)')
    // A proven end makes it a route, with the goal from its own field.
    const proven = [...blind, { ...blind[2], at: '2026-11-10T10:00:00Z', key: 'return', changed: true }]
    expect(routesOf(proven).map((r) => [r.goal, r.steps.map(stepText).join(' → ')])).toEqual([['send a mail', 'key "tab" → key "return"']])
    expect(learned([], 'Mail')).toBe('')
    // A ref given as a name landed by luck: no route, no dead end. A later try that changed nothing does not clear a dead end.
    n = 0
    const slip = [step('s3', 'rename a note', 'set-value', 'text area', 'e203@a3f1', { typed: 9 }), step('s3', 'rename a note', 'key', undefined, '', { key: 'return', changed: true }), step('s3', 'rename a note', 'set-value', 'text area', 'e12', { ok: false, reason: 'not-found' })]
    expect(routesOf(slip)).toEqual([])
    expect(deadEndsOf(slip)).toEqual([])
    const tried = [step('s4', 'x', 'pick-menu', 'menu item', 'Rename', { ok: false, reason: 'not-found' }), step('s4', 'x', 'pick-menu', 'menu item', 'Rename', { changed: false })]
    expect(deadEndsOf(tried).map(stepText)).toEqual(['pick-menu "Rename"'])
    expect(stepText({ verb: 'click', role: 'text', screenText: ['Inbox'] })).toBe('click {text: "Inbox"}')
    expect(stepText({ verb: 'pick-menu', role: 'menu item', screenText: ['New Window'] })).toBe('pick-menu "New Window"')
  })

  it('only the final clean attempt is a route: no earlier tries, no empty set-value, no circles (runs 9 and 10)', () => {
    n = 0
    const retry = [
      step('s3', 'pause it', 'press', 'button', 'Play'),
      step('s3', 'pause it', 'press', 'button', 'Pause', { ok: false, reason: 'not-found' }),
      step('s3', 'pause it', 'set-value', 'table', 'Tracks', { typed: 0 }),
      step('s3', 'pause it', 'press', 'button', 'Pause', { changed: true }),
    ]
    expect(routesOf(retry).map((r) => r.steps.map(stepText).join(' → '))).toEqual(['press {role: "button", label: "Pause"}'])
    const circles = ['Pause', 'Play', 'Pause', 'Play', 'Pause'].map((name, i) => step('s4', 'pause it', 'press', 'button', name, i === 4 ? { changed: true } : {}))
    expect(routesOf(circles)).toEqual([])
  })

  it('putting the screen back is not a route (run 14)', () => {
    n = 0
    const tidy = [step('s8', 'restore the search field text', 'set-value', 'combo box', 'What do you want to play?', { typed: 12, changed: true })]
    expect(routesOf(tidy)).toEqual([])
    const work = [step('s9', 'play the album', 'press', 'button', 'Play', { changed: true })]
    expect(routesOf(work).map((r) => r.goal)).toEqual(['play the album'])
  })

  it('no route from a set-value that replaced a text area or one that ends on Escape; a block done twice is learned once (run 11)', () => {
    n = 0
    expect(routesOf([step('s5', 'append a line', 'set-value', 'text area', 'Listening', { typed: 16, replaced: true, changed: true })])).toEqual([])
    expect(routesOf([step('s6', 'close it', 'press', 'button', 'More'), step('s6', 'close it', 'key', undefined, '', { key: 'escape', changed: true })])).toEqual([])
    const twice = [1, 2].flatMap(() => [step('s7', 'queue a song', 'press', 'button', 'More options'), step('s7', 'queue a song', 'press', 'menu item', 'Add to queue', { changed: true })])
    expect(routesOf(twice).map((r) => r.steps.map(stepText).join(' → '))).toEqual(['press {role: "button", label: "More options"} → press {role: "menu item", label: "Add to queue"}'])
  })

  it('what a run typed is a placeholder in its goal and later names, and two routes alike after that are one, the newest', () => {
    n = 0
    const run = (session, goal, song, typed, first = 'Search') => [
      step(session, goal, 'press', 'button', first),
      step(session, goal, 'set-value', 'combo box', 'What do you want to play?', { typed, changed: true }),
      step(session, goal, 'key', undefined, '', { key: 'return', changed: true }),
      step(session, goal, 'press', 'pop up button', `More options for ${song} - Remaster`, { changed: true }),
      step(session, goal, 'press', 'menuitem', 'Add to queue', { changed: true }),
    ]
    // "Blue Train" is the typed "Blue Train Lee Morgan"'s leading words; one word of 6 characters counts too.
    const rows = [...run('s1', 'queue blue train', 'Blue Train', 21), ...run('s2', 'queue moanin', 'Moanin', 13)]
    const routes = routesOf(rows)
    expect(routes.map((r) => [r.goal, r.steps.map(stepText).join(' → ')])).toEqual([
      ['queue <what was typed>', 'press {role: "button", label: "Search"} → set-value {role: "combo box", label: "What do you want to play?"} (a value, 13 characters) → key "return" → press {role: "pop up button", label: "More options for <what was typed> - Remaster"} → press {role: "menuitem", label: "Add to queue"}'],
    ])
    // Set 5 2A: listed by id, name and named place; no song of either run.
    expect(learned(rows, 'Spotify').split('\n')[1]).toMatch(/^- r\d{5}: queue \(What do you want to play\?\), worked 2 times: press "Search" > type What do you want to play\? > key return > press "More options for <what was typed> - Remaster" > press menuitem$/)
    expect(learned(rows, 'Spotify')).not.toMatch(/blue train|moanin/i)
    // A name before the typing is the app's own; words longer than the value typed, or one short word, are not what was typed.
    expect(routesOf(run('s5', 'queue moanin', 'Moanin', 13, 'Moanin radio'))[0].steps[0].screenText[0]).toBe('Moanin radio')
    n = 0
    expect(routesOf(run('s3', 'queue blue train', 'Blue Train', 5))[0].goal).toBe('queue blue train')
    expect(routesOf(run('s4', 'queue so what', 'So', 7))[0].steps[3].screenText[0]).toBe('More options for So - Remaster')
  })
})

describe('one brief builder (Round 2, item 4)', () => {
  it('the actions plugin adds no brief section: the routes reach the turn through the kernel brief', () => {
    expect(readFileSync(new URL('./index.js', import.meta.url), 'utf8')).not.toMatch(/briefSection/)
  })
})

describe('Fable M1, M4: a long text area is cut at print', () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i} of the Puzzlebox draft`).join('\n')
  const area = (more = {}) => el('e7', 'AXTextArea', 'Draft', [0, 0, 400, 400], { value: long, settable: true, ...more })
  const look = (more = {}, extra = {}) => ({ id: 'look-1', app: 'TextEdit', window: 'Draft', tag: 'ab12', elements: [area(more), el('e8', 'AXButton', 'Save', [0, 0, 10, 10], { actions: ['AXPress'] })], ...extra })

  it('a value over 600 characters prints its last 600 and says how long it is and how to read more', () => {
    const out = line(area())
    expect(out).toContain(`(${long.length} characters; screen_look {app, query} reads more)`)
    expect(out).toContain('line 79 of the Puzzlebox draft')
    expect(out).not.toContain('line 0 of the Puzzlebox draft')
    expect(out.length).toBeLessThan(800)
    expect(line(el('e1', 'AXTextField', 'Name', [0, 0, 1, 1], { value: 'Mira Bakker', settable: true }))).toBe('e1 field "Name" = "Mira Bakker"')
  })

  it('S5R1: the window\'s default and cancel buttons say so on their line, beside an off mark; every other line is as it was', () => {
    expect(line(el('e3', 'AXButton', 'Replace', [0, 0, 10, 10], { actions: ['AXPress'], default: true }), 'ab12')).toBe('e3@ab12 button "Replace" (default)')
    expect(line(el('e2', 'AXButton', 'Cancel', [0, 0, 10, 10], { actions: ['AXPress'], cancel: true, enabled: false }))).toBe('e2 button "Cancel" (cancel) (off)')
    expect(line(el('e4', 'AXButton', 'Save', [0, 0, 10, 10], { actions: ['AXPress'] }))).toBe('e4 button "Save"')
  })

  it('a cut part says it was cut and folded, and how to edit it', () => {
    expect(line(area({ cut: 9000 }), '', true)).toContain(`(last ${long.length} of 9000 characters, spacing folded: edit by click and type, not set-value)`)
  })

  it('the whole value only for the focused text area or one the query matches', () => {
    expect(format(look())).not.toContain('line 0 of the Puzzlebox draft')
    expect(format(look({}, { focused: 'e7' }))).toContain('line 0 of the Puzzlebox draft')
    expect(format(look(), { query: 'puzzlebox draft' })).toContain('line 0 of the Puzzlebox draft')
  })

  it('a changed value prints only its new tail, capped', () => {
    const before = look()
    const after = look({ value: `${long}\nline 80 the new one` })
    const d = diff(before, after)
    expect(d).toContain('line 80 the new one')
    expect(d).not.toContain('line 79 of the Puzzlebox draft')
    const grown = diff(before, look({ value: `${long}\n${'x'.repeat(2000)}` }))
    expect(grown.length).toBeLessThan(800)
  })
})
