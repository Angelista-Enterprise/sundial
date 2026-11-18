// Doc 16: the brain of "look, then act". Pure functions over one look (a `screen:looked` row): prune it, rank it,
// write the lines the model reads, and say what changed between two looks. No model, no network, no table per app.

/** The actions the app takes on a ref by its own name; every other verb is one of the element's AX actions. `open` is for an app, by name. */
export const FIXED = ['set-value', 'focus', 'click', 'type', 'key', 'scroll', 'pick-menu', 'select']
/** A ref as the model reads it: `e7@3c4d`, the tag of the app run (a thing keeps its label across the run's looks). A look with no tag (older rows) tags by the last four of its id. */
export const tagOf = (look) => String(look?.tag || String(look?.id ?? '').slice(-4))
export const refOf = (text) => {
  const [ref, tag = ''] = String(text ?? '').trim().split('@')
  return { ref, tag }
}
/** A look (a log row or `lookOf`'s) gives this ref: a thing's, or the caret line a text area carries (`c7`). */
export const hasRef = (look, ref) => (look?.elements ?? []).some((e) => e?.ref === ref || e?.caret?.ref === ref)
export const UNCHANGED = 'Nothing on screen changed.'
const tagged = (ref, tag) => (tag ? `${ref}@${tag}` : ref)
const verbOf = (ax) => String(ax ?? '').replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
const tokens = (s) => String(s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
const quote = (s) => JSON.stringify(String(s ?? ''))
const hid = (s) => /^\[(private|hidden)\]$/.test(String(s ?? ''))
const norm = (s) => String(s ?? '').trim().toLowerCase()
/** Chromium and Electron give nearly every node these two: they say nothing of what a thing is for. */
const FURNITURE = ['AXShowMenu', 'AXScrollToVisible']
/** A control a person works: when the two are all it offers (a menu button), they stay. */
const CONTROL = /Button|Link|MenuItem|CheckBox|ComboBox|PopUp|Slider|Disclosure|Incrementor|Tab/
const ownActions = (e) => {
  const own = (e.actions ?? []).filter((a) => !FURNITURE.includes(a))
  return own.length || !CONTROL.test(`${e.role} ${e.sub}`) ? own : (e.actions ?? [])
}
/** Electron wraps a field in a group or an unknown that says it takes a value: with no words and no value it is the wrapper, not the field. */
const settable = (e) => Boolean(e.settable) && Boolean(e.label || e.value || !/^AX(Group|Unknown)$/.test(e.role ?? ''))
const does = (e) => settable(e) || ownActions(e).length > 0
const inside = (a, b) => Boolean(a && b) && a[0] >= b[0] && a[1] >= b[1] && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3]
/** A part whose place is a sidebar: toolbars and tab bars hold main controls (a view popup, a browser's tabs). */
// Run 48 T05: Zen's tabs are tab buttons in its sidebar; a tab keeps its tree place.
const sidebar = (e) => /\bside ?bar\b/i.test(e.in ?? '') && !/\btab\b/.test(roleOf(e))
const centreIn = (a, b) => Boolean(a && b) && inside([a[0] + a[2] / 2, a[1] + a[3] / 2, 0, 0], b)

/** A log row back in the contract's names: the log keeps the app as `processName` and every screen word as `screenText`, the names the one redaction pass knows. */
export function lookOf(row) {
  if (!row) return null
  const { processName, windowTitle, windows, screenText, elements, ...rest } = row
  return {
    ...rest,
    app: processName ?? '',
    window: windowTitle ?? '',
    menus: screenText ?? [],
    windows: (windows ?? []).map(({ windowTitle: title = '', ...w }) => ({ ...w, title })),
    elements: (elements ?? []).map(({ screenText: [label = '', value = '', within = '', roleDescription] = [], ...e }) => ({ ...e, label, value, in: within, ...(roleDescription ? { roleDescription } : {}) })),
  }
}

/** "search field", "button", "row": the subrole when there is one, else the role. */
// Runs 49, 56, 60: Firefox and Zen give nearly every web part the subrole AXUnknown, so a label or a group read as "unknown".
export const roleOf = (e) => verbOf(e.sub && e.sub !== 'AXUnknown' ? e.sub : e.role).replace(/-/g, ' ')
/** The role as a line prints it: one word where the long name says no more ("static text" is text, "tab button" is tab). */
const SHORT = { 'static text': 'text', 'empty group': 'group', 'application group': 'group', 'tab button': 'tab', 'toggle button': 'toggle', 'pop up button': 'popup', 'content separator': 'separator', 'check box': 'checkbox', 'radio button': 'radio', 'combo box': 'combo', 'text field': 'field', 'text area': 'textarea', 'web area': 'page', 'disclosure triangle': 'disclosure', 'outline row': 'row', 'table row': 'row', 'menu button': 'button' }
const shortRole = (e) => {
  const r = roleOf(e)
  return SHORT[r] ?? r.replace(/^landmark /, '')
}

/** What can be done to an element, from its own AX action names: AXPress is press. Chromium's show-menu and scroll-to-visible only on a control that has nothing else. click when it offers nothing. */
export function verbs(e) {
  const all = [...(settable(e) ? ['set-value', 'focus'] : []), ...ownActions(e).map(verbOf)]
  return all.length ? [...new Set(all)] : ['click']
}

/** The name the app takes for a verb on this element: a fixed action as it is, else the element's own AX action. */
export const actionFor = (e, verb) => (FIXED.includes(verb) ? verb : (e.actions ?? []).find((a) => a === verb || verbOf(a) === verb))

/** A thing that takes a value or a press and carries its own words; a text with those words is its label. */
const FIELD = /field|check box|radio|pop up|button|text area|combo box/
/** Drop what says and does nothing, fold a row into its one child, drop doubles (the same words on the same spot). */
export function prune(elements) {
  const kept = (elements ?? []).filter((e) => e?.ref && (e.label || e.value || does(e)))
  const out = new Map(kept.map((e) => [e.ref, e]))
  // Children follow their parent in the tree's order: last first folds a cell into its row too.
  for (let i = kept.length - 1; i >= 0; i--) {
    const row = out.get(kept[i].ref)
    if (!row || !/Row|Cell/.test(row.role ?? '')) continue
    const kids = kept.slice(i + 1).map((e) => out.get(e.ref)).filter((e) => e && inside(e.frame, row.frame))
    const [kid] = kids
    if (kids.length !== 1 || (row.label && kid.label && row.label !== kid.label)) continue
    const [keep, drop] = does(row) || !does(kid) ? [row, kid] : [kid, row]
    out.set(keep.ref, { ...keep, label: keep.label || drop.label, value: keep.value || drop.value })
    out.delete(drop.ref)
  }
  const list = [...out.values()]
  // Run 67 T05: a web form's wrapper group outranked its own field of the same words, and the field went unlisted.
  const weight = (e) => (does(e) ? 2 : 0) + (/^(text|AXStaticText|AXGroup)$/.test(e.role ?? '') ? 0 : 1)
  const same = (a, b) => a.label && a.label.toLowerCase() === String(b.label).toLowerCase() && (centreIn(a.frame, b.frame) || centreIn(b.frame, a.frame))
  const unique = list.filter((e, i) => !list.some((o, j) => j !== i && same(e, o) && (weight(o) > weight(e) || (weight(o) === weight(e) && j < i))))
  // Run 36 T04: each cell of a web table came with its words again as its only child, a wordless "unknown", so every line showed twice.
  const echo = (e) => !e.label && e.value && !does(e) && unique.some((c) => /Cell/.test(c.role ?? '') && norm(c.label) === norm(e.value) && inside(e.frame, c.frame) && unique.filter((k) => k !== c && inside(k.frame, c.frame)).length === 1)
  // Run 67 T05: a field's label came as a text beside it, and the model set the value on the text.
  const words = (s) => norm(s).replace(/\s+/g, ' ')
  // A button's words may be a text elsewhere in its place, and a Calculator display is digits: only a field's place counts.
  const label = (e, i) => /^(static )?text$/.test(roleOf(e)) && !/^\d[\d\s.,]*$/.test(words(e.label || e.value)) && unique.some((c, j) => FIELD.test(roleOf(c)) && words(c.label) !== '' && words(c.label) === words(e.label || e.value) && (j === i + 1 || (/field|text area|combo box|pop up/.test(roleOf(c)) && (c.in ?? '') === (e.in ?? ''))))
  return unique.filter((e, i) => !echo(e) && !label(e, i))
}

/**
 * The elements a query names, best first: the query's words found in the label, the role and the `in`.
 * ponytail: whole words only, no stems or synonyms ("mails" misses "mail"); a local embedding is the upgrade when the find rate says so.
 */
export function rank(elements, query, window = '') {
  const asked = [...new Set(tokens(query))]
  if (asked.length === 0) return elements
  // Run 11: the window title is the place of nearly every part, so its words matched everything: a place counts only for its other words.
  const title = new Set(tokens(window))
  const sets = elements.map((e) => new Set([...tokens(`${e.label} ${e.value} ${roleOf(e)}`), ...tokens(e.in).filter((t) => !title.has(t))]))
  // A word many parts hold ("play" on 30 sidebar buttons, run 11) says little: each word weighs 1 / the parts it is in.
  const parts = Object.fromEntries(asked.map((w) => [w, sets.filter((set) => set.has(w)).length]))
  return elements
    .map((e, i) => [asked.reduce((n, w) => n + (sets[i].has(w) ? 1 / parts[w] : 0), 0), i, e])
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, , e]) => e)
}

/** One element as the model reads it: `e7@3c4d search field "Search" = "" [confirm]`. Press, click, set-value and focus go unsaid (the screen_look description says so). Its place is the `in` line above it. A menu item that is on carries ✓, one that opens a submenu ›, and its key as the menu draws it (⇧⌘G). S5R1: the button a Return in a one-line field presses says (default), the one Escape presses (cancel). */
export const line = (e, tag = '', full = false) => {
  const can = verbs(e).filter((v) => !['press', 'click', 'set-value', 'focus'].includes(v))
  return `${tagged(e.ref, tag)} ${shortRole(e)}${e.label ? ` ${quote(e.label)}` : ''}${e.checked ? ' ✓' : ''}${e.submenu ? ' ›' : ''}${e.keys ? ` ${e.keys}` : ''}${settable(e) || e.value ? ` = ${valueOf(e, full)}` : ''}${can.length ? ` [${can.join(', ')}]` : ''}${e.default ? ' (default)' : ''}${e.cancel ? ' (cancel)' : ''}${e.enabled === false ? ' (off)' : ''}`
}
/** S4 (Fable M1): at most this much of a value is printed, unless the look was asked for that thing. */
const SHOWN = 600
/** The end of a long text, from a line's start when it has one. */
const tail = (text, n = SHOWN) => {
  const t = String(text).slice(-n)
  const at = t.indexOf('\n')
  return at >= 0 && at < t.length - 1 ? t.slice(at + 1) : t
}
/** A value as a line prints it: a long one (a text area, up to 4,000 characters) by its end and its length; one the app cut or folded (M4) says so. */
const valueOf = (e, full) => {
  const v = String(e.value ?? '')
  const long = !full && v.length > SHOWN
  return `${quote(long ? tail(v) : v)}${long ? ` (${e.cut ?? v.length} characters; screen_look {app, query} reads more)` : ''}${e.cut ? ` (last ${v.length} of ${e.cut} characters, spacing folded: edit by click and type, not set-value)` : e.folded ? ` (blank lines and indents folded, ${e.chars ?? v.length} characters: edit by click and type, not set-value)` : ''}`
}
/** The lines of a list, each run of one place under one `in` line. `full`: the refs whose whole value prints. */
const lines = (list, tag, full = new Set()) => list.flatMap((e, i) => [...((e.in ?? '') === (i ? (list[i - 1].in ?? '') : '') ? [] : [`in ${e.in || 'the window'}:`]), line(e, tag, full.has(e.ref))])

/** One key per element: its label in a look with a tag (the same label is the same thing across the app run's looks), else role, words and place. The second of two alike is "#2". A line of text is keyed by its words. */
const name = (e) => `${shortRole(e)}${e.label ? ` ${quote(e.label)}` : ''}`
const base = (e) => `${roleOf(e)} ${quote(e.label)} in ${quote(e.in)}`
const fixed = (look, e) => Boolean(look?.tag) && !/^t/.test(e.ref ?? '')
const keyOf = (look, e) => (fixed(look, e) ? `${e.ref}@${look.tag}` : base(e))
function keysOf(list, look) {
  const seen = new Map()
  return list.map((e) => {
    if (fixed(look, e)) return keyOf(look, e)
    const n = (seen.get(base(e)) ?? 0) + 1
    seen.set(base(e), n)
    return `${base(e)} #${n}`
  })
}
/** What is in `after` and was not in `before`, what went, and which values changed. */
function delta(before, after) {
  const [was, now] = [prune(before.elements), prune(after.elements)]
  const run = before.tag === after.tag ? after : null
  const [wasKeys, nowKeys] = [keysOf(was, run), new Set(keysOf(now, run))]
  const wasBy = new Map(was.map((e, i) => [wasKeys[i], e]))
  const here = keysOf(now, run).map((key, i) => ({ ...now[i], key }))
  return {
    appeared: here.filter((e) => !wasBy.has(e.key)),
    gone: was.filter((_, i) => !nowKeys.has(wasKeys[i])),
    changed: here.filter((e) => wasBy.has(e.key) && (wasBy.get(e.key).value ?? '') !== (e.value ?? '')).map((e) => ({ ...e, was: wasBy.get(e.key).value ?? '' })),
  }
}

/**
 * A ref from an older look of the same app, carried to the newest: in one app run the same label, else the thing with the same
 * role, words and place. Null when it went, or when the things alike changed in number (which one is which would be a guess).
 * Sundial.app still checks the role and the words before it acts.
 */
export function carry(was, now, ref) {
  if (was?.tag && was.tag === now?.tag && !/^t/.test(ref)) return (now.elements ?? []).find((e) => e.ref === ref) ?? null
  const [a, b] = [prune(was?.elements), prune(now?.elements)]
  const i = a.findIndex((e) => e.ref === ref)
  if (i < 0) return null
  const alike = (list) => list.filter((e) => base(e) === base(a[i])).length
  if (alike(a) !== alike(b)) return null
  return b[keysOf(b).indexOf(keysOf(a)[i])] ?? null
}

const flat = (s) => norm(s).replace(/^ax/, '').replace(/[^\p{L}]/gu, '')
/** Every name a thing's role goes by: as a line prints it, as the look says it, and the AX role under a subrole. */
const roleNames = (e) => new Set([shortRole(e), roleOf(e), e.role, e.sub].filter(Boolean).map(flat))
/**
 * The one thing of a look a name points at, for an act by name: its words exactly, and its role when the role fits.
 * A role fits by any of its names, or as their last word ("field" fits a search field). Null when nothing, or more than one.
 */
export function resolve(look, { role, label, text } = {}) {
  const words = norm(label ?? text)
  if (!look || !words) return null
  const named = prune(look.elements).filter((e) => norm(e.label) === words)
  // A role the model gave is kept: with no thing of that role, the by-name path decides (and can say not-found).
  const found = role ? named.filter((e) => [...roleNames(e)].some((n) => n.endsWith(flat(role)))) : named
  return found.length === 1 ? found[0] : null
}

/** The app's windows other than the one read; empty when there is none. */
export function windowsLine(look) {
  const others = (look?.windows ?? []).filter((w) => w.title && w.title !== look.window && !hid(w.title))
  return others.length ? `Other windows: ${others.map((w) => `${quote(w.title)}${w.minimized ? ' (minimized)' : ''}`).join(', ')}.` : ''
}

/** Run 30: a web address opened answered with the page's 400 parts, twice. After one: the window title, the tabs in order and the other windows. */
export function pageLines(look) {
  // A page's own tabs (a pull request's "Commits") take the same roles: only those outside the web area are the browser's.
  const pages = (look.elements ?? []).filter((e) => /WebArea/.test(e.role ?? ''))
  const inPage = (e) => /^(web area|html content)$/i.test(e.in ?? '') || pages.some((p) => centreIn(e.frame, p.frame) || (p.label && e.in === p.label))
  const tabs = (look.elements ?? []).filter((e) => /\btab\b/.test(roleOf(e)) && e.label && !hid(e.label) && !inPage(e))
  return [
    `${look.app}, window ${quote(look.window)}. The page is not listed: screen_look {app} reads it.`,
    tabs.length ? `Tabs, in order: ${tabs.slice(0, 30).map((e) => `${quote(e.label)}${String(e.value) === '1' ? ' (shown)' : ''}`).join(', ')}${tabs.length > 30 ? `, and ${tabs.length - 30} more` : ''}.` : '',
    windowsLine(look),
  ].filter(Boolean).join('\n')
}

/** The text the model reads for one look: a head, one line per element up to the budget (what is new since `before` first), the menus, and how to ask for the rest. */
/** How many things with the very same words and role are worth listing before the rest are just counted. */
const ALIKE = 3
/** What a format of the look lists, as keys (`keyOf`): a later look of the same window is matched by these. */
export const listed = (look, opts) => new Set(choose(look, opts).shown.map((e) => keyOf(look, e)))
/** At most this many new matches in an answer to a look that repeats the one before. */
const AGAIN = 30
/** The most things one look sends (the look command's `max`): a look that holds this many was cut by it, not by the clock. */
export const MAX = 400
/**
 * S5R2 (plan 2B): a Save or Open panel holds the keyboard: the look's dialog with an Open or Choose button, or a Save button
 * and a text field (its name). A "save changes?" alert has Save but no field. Doc 30 (runs 250 to 253): keys never reached it, while
 * clicks, presses and set-value did, so the look's line points to the column browser, the name field and the Save button.
 */
const named = (e, role, re) => roleOf(e) === role && re.test(String(e.label ?? '').trim())
/**
 * The title bar's rename popover (Name, Tags, Where; TextEdit's cmd+shift+s makes a copy and shows it): run 257 read it as a popover
 * "Name:, Tags:, Where:", S5R4 (run 248 T19) as a dialog whose name field is "Name" with no Cancel. It is no panel (doc 31).
 */
export const renamePopover = (look) => {
  const all = look?.elements ?? []
  return all.some((e) => named(e, 'popover', /\bwhere\b/i)) || (look?.dialog === true && all.some((e) => named(e, 'text field', /^name:?$/i)) && !all.some((e) => named(e, 'button', /^cancel$/i)))
}
export const savePanel = (look) => {
  const parts = look?.dialog === true ? (look.elements ?? []) : []
  const button = (re) => parts.some((e) => named(e, 'button', re))
  if (renamePopover(look)) return false
  // Doc 31 (runs 254 to 257, 4 of 4): the look that comes with the menu pick is taken while the sheet still draws: its sheet
  // ("save") or its Where pop-up and the name field are there, its Save and Cancel buttons not yet.
  const drawing = parts.some((e) => (roleOf(e) === 'sheet' && /^(?:save|open)$/i.test(String(e.label ?? '').trim())) || (roleOf(e) === 'pop up button' && /^where:?$/i.test(String(e.label ?? '').trim())))
  return button(/^(?:open|choose)$/i) || ((drawing || button(/^save$/i)) && parts.some((e) => roleOf(e) === 'text field'))
}
/** What the app says about the window itself: a window the owner cannot see, and a dialog that must be answered before anything behind it works. */
const state = (look) => [
  look.front === false ? `${look.app} is NOT in front: this window is behind another app's. Bring it up (screen_act {app}) before a step, or the owner sees nothing happen.` : '',
  look.dialog === true ? `A dialog or sheet holds the keyboard: answer or close it first (its buttons are in this list), because nothing behind it can be used.${savePanel(look) ? ' It is a Save or Open panel: to save there, one step {app, action: "save-as", value: "/the/folder/name.ext"}; to go to a folder, {app, action: "go-to-folder", value: "/the/folder"}; both click through its sidebar and folder columns. Keys and typing do not reach it; clicks, presses and set-value do: by hand, click down the folders of the path in its column browser (a folder a click does not open takes a double-click: {ref, action: "click", count: 2}), set-value its name field, then press its Save button.' : ''}` : '',
  // Doc 31: every save-where turn tried this popover's Where pop-up 3 or 4 times (10 tries, none opened), 6 to 8 calls a turn.
  renamePopover(look) ? 'This is the title bar\'s rename popover (Name, Tags, Where), not a Save panel: its Where pop-up does not open, so do not try it. To save the document in a folder: one step {app, action: "save-as", value: "/the/folder/name.ext"}: it opens the real Save panel by the File menu (Save As…, or Duplicate then Save), clicks it to the folder, sets the name and presses Save.' : '',
  // Run 42 T07: Finder's column view holds no size, and the model looked for one for 21 steps.
  (look.elements ?? []).some((e) => e.role === 'AXBrowser' || norm(e.in) === 'column view') ? `This window is in column view: ${look.app === 'Finder' ? 'it lists names only, no size, date or kind. For those, switch to list view (View > as List, or cmd+2) or read the folder from the shell.' : 'names only, no size, date or kind.'}` : '',
]
// An item of an open menu sits in a menu bar title, in a "menu", or in such an item; a page's own menuitem role does not.
const nativeItems = (look) => {
  const all = (look?.elements ?? []).filter((e) => e.label && /menu ?item/i.test(roleOf(e)))
  const places = new Set(['menu', ...(look?.menus ?? []).map(norm)])
  for (let n = -1; n !== places.size; ) {
    n = places.size
    for (const e of all) if (places.has(norm(e.in))) places.add(norm(e.label))
  }
  return all.filter((e) => places.has(norm(e.in)))
}
const menuItems = (look) => new Set(nativeItems(look).map((e) => e.label))
/** An item's path from the menu bar ("View > Sort By"), climbing the items its `in` names. */
const pathOf = (native, e, n = 0) => {
  const up = n < 4 && native.find((o) => o !== e && norm(o.label) === norm(e.in))
  return `${up ? pathOf(native, up, n + 1) : e.in} > ${e.label}`
}
/** Run 128: a pick-menu "Edit > Find" was refused three times; the refusal names the one call that reads the submenu, then the pick. */
export const submenuHint = (app, path, item = '<the item>') => `${quote(path)} opens a submenu, which is never pressed: read it with screen_look ${JSON.stringify({ app, menu: path })}, then pick the item by its whole path, ${JSON.stringify({ app, action: 'pick-menu', value: `${path} > ${item}` })}.`
// Runs 42, 50, 57: a press on "Sort By" froze Finder; a real click is the safe way to open one, so it goes through. A submenu parent is flagged by the app, or (an older look) told apart once open: its items name it as their `in`.
export function submenuRefusal(look, { label, role } = {}, verb) {
  if (!norm(label) || (role && !/menu ?item/i.test(role)) || !['press', 'pick', 'pick-menu', 'show-menu'].includes(verb)) return null
  const native = nativeItems(look)
  const items = native.filter((e) => norm(e.in) === norm(label))
  const parent = native.find((e) => norm(e.label) === norm(label) && (e.submenu || items.length))
  const item = items.find((e) => e.enabled !== false) ?? items[0]
  return parent ? `refused: ${submenuHint(look.app, pathOf(native, parent), item?.label)}` : null
}
/** Run 42 T07: a View menu stayed open through four Escapes, and every look carried its 34 items. After an escape: the look before it and after. */
export const stuckMenu = (look, was) => (was && was.app === look?.app && was.id !== look.id && [...menuItems(look)].some((l) => menuItems(was).has(l)) ? 'A menu is still open from an earlier step: close it first (key escape; if it stays open, press its menu bar item again).' : '')
/**
 * Runs 17 to 31: 37 looks repeated the one before, the same window with nothing done between and only the query new,
 * and each cost about 1.7k tokens that every later call read again; in 10 of 13 such chains the thing finally acted on
 * was already listed in the first answer. The look is still taken (the screen may have moved), but the answer is what
 * changed and the matches not listed before (`known`, keys from `listed`). `listed` in the result: the keys it printed.
 */
/** Run 36 T04: a whole look not cut off, every thing in it already printed to the model: nothing more is hidden. */
export const allListed = (look, known) => !look.truncated && prune(look.elements).every((e) => known.has(keyOf(look, e)))
export function again(now, was, { query, known }) {
  const fresh = rank(prune(now.elements), query, now.window).filter((e) => !known.has(keyOf(now, e)))
  const shown = fresh.slice(0, AGAIN)
  const whole = !shown.length && allListed(now, known)
  // A look cut short holds the query's best and a different rest each time: what appeared or went between two of them
  // is noise, but a value that changed on a thing both hold (a field the owner typed in, a toggle) is not.
  const d = diff(was, now)
  const kept = now.truncated || was.truncated ? d.split('\n').filter((l) => !/^(appeared|gone): /.test(l) && l !== UNCHANGED).join('\n') : d
  const changed = kept === UNCHANGED ? kept : kept ? `What changed:\n${kept}` : 'No value changed on the things both looks hold.'
  // The owner can open another window, an app or a sheet with no step of Gnomon's between.
  const windows = windowsLine(now)
  const text = [
    `${now.app}, window ${quote(now.window)}: the window of your last look, with nothing done since. Its refs still work; only what is new to you is listed.`,
    ...state(now),
    windows !== windowsLine(was) ? windows : '',
    changed,
    shown.length ? `Matching ${quote(query)}, not listed before:` : whole ? `Nothing matching ${quote(query)} is new, and nothing more is hidden: every thing in this window is in the lines you already have.` : `Nothing matching ${quote(query)} is new: what you look for is in the lines you already have, or not in this window (scroll it, or name another window).`,
    ...lines(shown, tagOf(now)),
    fresh.length > shown.length ? `${fresh.length - shown.length} more match: fewer, rarer words narrow it.` : '',  ].filter(Boolean).join('\n')
  return { text, listed: new Set(shown.map((e) => keyOf(now, e))) }
}
function choose(look, { query, budget = 60, before } = {}) {
  const all = prune(look.elements)
  const hits = query ? rank(all, query, look.window) : all
  // Real use 2026-11-13: a query dropped every part it did not name, and a list of 30 rows read as one. Matches first, then the rest.
  // Run 42 T07: 44 sidebar parts filled the budget ahead of the window's 5 files. The window's own parts come before its sidebar.
  const rest = all.filter((e) => !hits.includes(e))
  const found = [...hits, ...rest.filter((e) => !sidebar(e)), ...rest.filter(sidebar)]
  const d = before && before.app === look.app ? delta(before, look) : null
  const fresh = d ? new Set([...d.appeared, ...d.changed].map((e) => e.ref)) : null
  const pool = fresh ? [...found.filter((e) => fresh.has(e.ref)), ...found.filter((e) => !fresh.has(e.ref))] : found
  // Run 12: fourteen rows called "Add to Liked Songs" pushed the two things the step needed past the cut.
  // The same words on the same kind of thing say nothing new after a few: the rest are counted, not listed.
  const seen = new Map()
  const thinned = pool.filter((e) => {
    const k = `${roleOf(e)}|${String(e.label ?? '').trim().toLowerCase()}`
    if (!e.label) return true
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    return n <= ALIKE
  })
  const alike = [...seen.entries()].filter(([, n]) => n > ALIKE)
  const more = Math.max(0, thinned.length - Math.min(thinned.length, budget) - thinned.slice(budget).filter((e) => /menu ?item/i.test(roleOf(e))).length)
  // Run 13: a context menu came back as twelve items and "23 more", which cost a look to find "Close Tab".
  // A menu is small and the whole point is to pick from it, so its items are never cut.
  const menu = (e) => /menu ?item/i.test(roleOf(e))
  // The keyboard's element is named only when the look holds it, and always gets its line.
  const focused = (look.elements ?? []).find((e) => e.ref === look.focused)
  const top = [...thinned.slice(0, budget), ...thinned.slice(budget).filter(menu)]
  const shown = focused && !top.some((e) => e.ref === focused.ref) ? [...top, focused] : top
  // The query's matches past the cut: not those counted as alike, which the alike line names.
  const unshown = query ? thinned.filter((e) => hits.includes(e) && !shown.includes(e)).length : 0
  // Run 42 T07: "none of them match" over 5 hidden file names read as "no files here".
  const names = thinned.some((e) => !shown.includes(e) && !sidebar(e) && /field|row|cell/.test(roleOf(e)))
  return { all, hits, alike, more, focused, shown, unshown, names }
}
export function format(look, { query, budget = 60, before, doc } = {}) {
  const { all, hits, alike, more, focused, shown, unshown, names } = choose(look, { query, budget, before })
  const tag = tagOf(look)
  return [
    `${look.app}, window ${quote(look.window)}: ${all.length} things${focused ? `, keyboard in ${tagged(focused.ref, tag)}` : ''}.`,
    doc ? `document: ${doc}` : '',
    ...state(look),
    windowsLine(look),
    query && hits.length === 0 ? `Nothing matches ${quote(query)}. The top of the window:` : '',
    // M1: the whole value only for the thing with the keyboard and the query's matches.
    ...lines(shown, tag, new Set([look.focused, ...(query ? hits.map((e) => e.ref) : [])])),
    look.menus?.length ? `menus: ${look.menus.map((m) => (/[\s,]/.test(m) ? quote(m) : m)).join(', ')}` : '',
    alike.length ? `${alike.map(([k, n]) => `${n} things say ${JSON.stringify(k.split('|')[1])}`).slice(0, 4).join(', ')}: only the first ${ALIKE} of each are listed, and they are rows of a list. Act on the one you want by the words NEXT to it, or scroll.` : '',
    // Runs 17 to 31: after a look with a query that was cut off, 54% of the next two steps looked again with other words
    // (39% when not cut), and in none of 13 such chains was the thing then acted on past the cut. These two lines said
    // "look again with query" to a look that had one: with a query they now say where the matches are.
    more > 0 ? (query ? `${more} more not shown${unshown ? `, ${unshown} of them match ${quote(query)}: fewer, rarer words narrow it.` : names ? ' (names and rows among them): ask with a word from their names, or no query.' : `, none of them match ${quote(query)}.`}` : `${more} more not shown: look again with query, a few words of what you look for.`) : '',
    // Only a look cut by the item budget read on past the cut for the query's words; one cut by the clock did not.
    look.truncated ? (query ? `The window holds more than one look reads${(look.elements ?? []).length >= MAX ? `; the app read further for the words of ${quote(query)}, and what it found is listed first` : ''}. For something else: other words, or name the window.` : 'The window holds more than one look takes: look again with query, or name the window.') : '',
    look.ocr === 'no grant' ? 'Text inside pictures was not read: Screen Recording is not granted.' : look.ocr === 'failed' ? 'Text inside pictures was not read this time.' : '',
  ].filter(Boolean).join('\n')
}

/** The thing with the keyboard, as a diff names it (`e5@3c4d field "Title"`), or '' when the look names none. */
export const keyboardIn = (look) => (look?.elements ?? []).filter((e) => e.ref === look.focused).map((e) => `${tagged(e.ref, tagOf(look))} ${name(e)}`)[0] ?? ''

/** What one step changed: the window title, the focus, what appeared, what went, which values changed. Things are matched by label within one app run (`keysOf`), else by role and words. */
export function diff(before, after) {
  if (!before || !after || before.app !== after.app) return ''
  const { appeared, gone, changed } = delta(before, after)
  const tag = tagOf(after)
  const some = (list, say) => `${list.slice(0, 6).map(say).join(', ')}${list.length > 6 ? `, and ${list.length - 6} more` : ''}`
  const focus = (look) => (look.elements ?? []).filter((e) => e.ref === look.focused).map(name)[0] ?? ''
  const lines = [
    before.window !== after.window ? `window: now ${quote(after.window)}` : '',
    focus(after) && focus(after) !== focus(before) ? `focus: ${tagged(after.focused, tag)} ${focus(after)}` : '',
    appeared.length ? `appeared: ${some(appeared, (e) => `${tagged(e.ref, tag)} ${name(e)}`)}` : '',
    gone.length ? `gone: ${some(gone, name)}` : '',
    changed.length ? `changed: ${some(changed, (e) => `${tagged(e.ref, tag)} ${name(e)} = ${grew(e.was, e.value)}`)}` : '',
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : UNCHANGED
}

/** M1: a long value that changed prints only what is new at its end, capped; a short one prints whole. */
function grew(was, now) {
  const [a, b] = [String(was ?? ''), String(now ?? '')]
  if (b.length <= SHOWN) return quote(b)
  const same = [...b].findIndex((c, i) => a[i] !== c)
  const fresh = same < 0 ? '' : b.slice(same)
  return `${quote(fresh.length > SHOWN ? tail(fresh) : fresh)} (new at the end of ${b.length} characters)`
}

/** After a step the window is the one it was: the same title, nothing went, and the diff names all that is new. The refs held for it carry over, so it is not listed again. */
export function holds(before, after) {
  if (!before || !after || before.app !== after.app || before.window !== after.window) return false
  const { appeared, gone } = delta(before, after)
  return gone.length === 0 && appeared.length <= 6
}

/**
 * A chain answers with its last step's text (`text`). A "has a sheet you did not open" line (screen-leftover.js) is said once per
 * chat, task and app, by the first look that saw the sheet: one an earlier step's look said (`earlier`, those steps' texts) is kept,
 * once, else the chain's answer never carries it.
 */
export const saidBefore = (text, earlier) => [String(text ?? ''), ...new Set(earlier.flatMap((t) => String(t ?? '').split('\n')).filter((l) => / has a sheet you did not open\b/.test(l) && !String(text ?? '').includes(l)))].join('\n')

/** The lines of a screen-text row (`screen:ocr`) that hold half the query's words or more, most first. */
export function textLines(text, query, n = 8) {
  const asked = [...new Set(tokens(query))]
  if (!asked.length || typeof text !== 'string' || hid(text)) return []
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))]
    .map((l, i) => [asked.filter((w) => tokens(l).includes(w)).length, i, l.slice(0, 120)])
    .filter(([k]) => k > 0 && k >= asked.length / 2)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, n)
    .map(([, , l]) => l)
}

// The routes the log holds per app moved to helpers, so the turn brief and screen_act read one copy.
export { TYPED, deadEndsOf, learned, looksLikeRef, routesOf, stepCall, stepText } from '@sundial/helpers/screen-routes.js'

/**
 * Run 22: text meant for a note went into its title and renamed it, and the answer did not say. A type step says where
 * the text went (the field with the keyboard after it), and a new window title that holds the text is said. Many apps
 * title a window by what was typed (Mail's subject, the first line in Notes), so it is called a probable rename, and a
 * chain stops (`renamed`), only when the keyboard is in a title or name field, in no field, or (`plan.aimed`) the chain
 * pressed a text that was the old title, as run 22 pressed the note's inline title.
 */
export function wentTo(plan, { now, was } = {}) {
  if (!now || !['type', 'set-value'].includes(plan.verb) || typeof plan.command.value !== 'string') return {}
  const into = keyboardIn(now)
  const typed = plan.command.value.trim().toLowerCase().slice(0, 30)
  const retitled = Boolean(was && was.app === now.app && was.window !== now.window && typed.length > 1 && String(now.window).toLowerCase().includes(typed))
  const field = (now.elements ?? []).find((e) => e.ref === now.focused)
  const renamed = retitled && (!field || /title|name/i.test(`${roleOf(field)} ${field.label}`) || Boolean(plan.aimed && String(was.window).toLowerCase().includes(plan.aimed)))
  // A set-value goes to the thing it named; a type goes wherever the keyboard is.
  const where = plan.verb !== 'type' ? '' : into ? `The text went to the field with the keyboard: ${into}.` : 'The look after names no field with the keyboard: check where the text went before typing more.'
  // Run 213 T03: a type meant for "To" went into the page's Quick find (the app was not in front yet), the chain pressed Send on
  // an empty To, and every later try typed the address twice. A type aimed at a ref of the look that left the keyboard in another
  // field by another name stops the chain (`strayed`): what came after it was meant for a form that does not hold the text.
  const meant = String(plan.thing?.name ?? '').trim().toLowerCase()
  const label = String(field?.label ?? '').trim().toLowerCase()
  const strayed = plan.verb === 'type' && Boolean(plan.command.ref && field && meant && label && field.ref !== plan.command.ref && !label.includes(meant) && !meant.includes(label))
  return { renamed, strayed, note: [where, strayed ? `It was meant for ${JSON.stringify(plan.thing.name)}.` : '', retitled ? `The window title changed from ${JSON.stringify(was.window)} to ${JSON.stringify(now.window)}${renamed ? ': the text may have gone into a title or name field' : ''}.` : ''].filter(Boolean).join(' ') }
}
