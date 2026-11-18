// What a call does that cannot be taken back (a final: a send, a delete, a payment ...), where it lands, and whether it reaches
// into a private app or types blind: the facts the action gate (gate.js) decides on, and the ask a final puts to the owner.

import { privateAppName, privateApps } from '@sundial/helpers/redact/redact-policy.js'
import { COMPOSER, finalRe, finalWord, knownButton, RUNS_RETURN, talkOf } from './final-words.js'
import { boxRole, defaultFinal } from './default-final.js'
import { commandLine, commandOf, quote, touchesLine, touchesOf } from './gate-shell.js'
import { DECLARED_TOOLS, GNOMON_TOOLS } from './gate-tools.js'
import { looksLikeRef, roleOf, savePanel } from './screen-look.js'
import { savesOver } from './screen-save.js'
import { pointFinal } from './screen-point.js'
// Doc 27 section 3: screen-tools.js (at its line cap) takes the point steps through this module.
export { POINT_PARAMS, pointAct, pointPlan } from './screen-point.js'

// --- a send: a mail or a message leaving the machine (owner decision 2026-11-12) ---
/** The apps a send key sends from, as words of an app name or bundle id. The one list of each. */
export const MAIL_APPS = ['mail', 'outlook', 'spark', 'mimestream', 'airmail', 'thunderbird', 'canary', 'superhuman', 'postbox', 'mailspring', 'missive']
export const BROWSERS = ['safari', 'chrome', 'chromium', 'firefox', 'arc', 'brave', 'edge', 'opera', 'vivaldi', 'orion', 'zen', 'dia']
const SEND_KEYS = new Set(['cmd+shift+d', 'cmd+enter', 'cmd+return', 'ctrl+enter', 'ctrl+return'])
/** Keys that press the thing the keyboard is in. */
const ENTER_KEYS = new Set(['return', 'enter', 'space', 'kp_enter', 'kp-enter'])
/** Keys that send from a chat's message box. Shift+Return (a new line) is none of them. */
const RETURNS = new Set(['return', 'enter', 'kp_enter', 'kp-enter', 'cmd+enter', 'cmd+return', 'ctrl+enter', 'ctrl+return'])
/** Keys that put the keyboard in a find or address field. */
const FIND_KEYS = new Set(['cmd+f', 'cmd+l'])
/** Keys that edit or select in the thing the keyboard is in and leave the keyboard there (runs 154, 155: cmd+a before typing a name). */
const EDIT_KEYS = new Set(['cmd+a', 'cmd+c', 'cmd+x', 'cmd+v', 'cmd+z', 'cmd+shift+z'])
/** Apps where cmd+n opens a new document with the keyboard in its text (review, Set 2 R1): nowhere else is it known (Terminal runs what is typed). */
const NEW_DOC_APPS = ['textedit', 'obsidian', 'notes', 'pages']
/**
 * cmd+t or cmd+n in a browser (its address bar), cmd+n in one of NEW_DOC_APPS, or cmd+shift+g in Finder (Go to Folder; runs 191,
 * 193) puts the keyboard in a field. S5R2 (plan 2B): so does cmd+shift+g in a Save or Open panel the look shows in front (`panel`,
 * judgedPlans): its "Go to the folder" field, whose Return only moves the panel. Anywhere else it stays a key that moved the keyboard.
 */
const opensField = (key, app, panel = false) => (['cmd+t', 'cmd+n'].includes(key) && oneOf(BROWSERS, app)) || (key === 'cmd+n' && oneOf(NEW_DOC_APPS, app)) || (key === 'cmd+shift+g' && (panel || /^finder$/i.test(String(app ?? ''))))
/**
 * A key that moves the caret inside a text field: 'line' (left, right, home, end) or 'vertical' (up, down, a page key), else null.
 * Bare, with shift, and with at most one of cmd or alt: alt+cmd+arrow switches tabs, ctrl+arrow switches Spaces, so neither is a caret key.
 * A vertical key stays in a text area only: in a search field or a combo box it picks a hidden suggestion, which Return then runs.
 */
const caretKey = (key) => {
  if (/^(?:alt\+)?shift\+(?:return|enter)$|^alt\+(?:return|enter)$/.test(key)) return 'vertical'
  const m = /^(?:(?:alt|cmd)\+)?(?:shift\+)?(?:(up|down|page-?up|page-?down)|left|right|home|end)$/.exec(key)
  return m ? (m[1] ? 'vertical' : 'line') : null
}
const AREA = /text ?area/i
// --- a chat's message box: Return there sends (S5R1). The box shows its Send beside it, or the app is a chat app. ---
/** Chat apps, as words of an app name or bundle id (Element is im.riot.app). Private ones are refused before this. */
export const CHAT_APPS = ['slack', 'teams', 'discord', 'telegram', 'signal', 'element', 'riot', 'mattermost', 'zulip', 'whatsapp', 'messenger', 'skype', 'beeper']
/** A chat in a browser tab, by the words or the address its window title or page shows. */
const CHAT_PAGE = /\b(?:slack|microsoft teams|discord|telegram|signal|element|mattermost|zulip|whatsapp|messenger|google chat)\b|\b(?:slack|discord|whatsapp|messenger|zulipchat)\.com\b|teams\.microsoft|chat\.google|web\.telegram\.org|app\.element\.io/i
/** Apps where Return in a box is a line or a command, never a send: code editors, terminals, text editors. */
const TERMINALS = ['terminal', 'iterm', 'iterm2', 'warp', 'ghostty', 'kitty', 'alacritty', 'wezterm']
const NO_COMPOSER = ['code', 'vscode', 'cursor', 'windsurf', 'xcode', 'zed', 'sublime', 'nova', 'bbedit', 'coteditor', 'textedit', 'notes', 'obsidian', 'pages', ...TERMINALS, 'intellij', 'pycharm', 'webstorm', 'jetbrains', 'macvim', 'emacs']
/** Whether `app` (or the look of it) is a chat: by name or bundle id, or a browser tab whose title or page names one. */
export const chatApp = (app, look) => oneOf(CHAT_APPS, app) || (look?.app === app && (oneOf(CHAT_APPS, look.bundleId) || (oneOf(BROWSERS, app) && CHAT_PAGE.test([look.window, ...(look.elements ?? []).filter((e) => /WebArea/.test(e.role ?? '')).flatMap((e) => [e.label, e.value])].join(' ')))))
/** A one-line field a chat moves with (S5R1): Jump to, Find, Go to, Filter, the quick switcher. Return there opens, it sends nothing. */
const NAVIGATOR = /^\s*(?:jump to|find|go to|filter|quick ?switcher|switch to)\b/i
/**
 * A box a message is typed in: a text field or area, not an address bar, a search or a one-line navigator. A name that says
 * whom it writes to ("Message #search-team") is a box whatever the conversation is called (S5R1).
 */
const isBox = (thing) => {
  const [role, name] = [String(thing?.role ?? ''), String(thing?.name ?? '')]
  return /text ?field|text ?area|textbox/i.test(role) && (talkOf(name) !== null || (!/address|url|location|search/i.test(name) && !(/text ?field/i.test(role) && NAVIGATOR.test(name))))
}
const near = (a, b) => Array.isArray(a) && Array.isArray(b) && Math.max(b[0] - a[0] - a[2], a[0] - b[0] - b[2]) <= 48 && Math.max(b[1] - a[1] - a[3], a[1] - b[1] - b[3]) <= 48
/** The space between two frames, across and down (0 when they touch or overlap); unknown frames are as far as can be. */
const gap = (a, b) => (Array.isArray(a) && Array.isArray(b) ? Math.max(0, b[0] - a[0] - a[2], a[0] - b[0] - b[2]) + Math.max(0, b[1] - a[1] - a[3], a[1] - b[1] - b[3]) : Infinity)
/**
 * The words of the button a message box `e` sends with: a Send, Post, Reply, Comment or Submit button next to it, or in its
 * container when no other box is there. A one-line field beside it makes it a form's body (a mail's To and Subject): Return
 * there adds a line, null. S5R1: other message boxes (a thread pane beside the main one) leave the button nearest `e` and nearer
 * it than any of them; a box that overlaps `e` (an Electron wrapper) is `e` itself. Else null.
 */
export function composerFinal(look, e) {
  if (!look || !e || !isBox({ role: boxRole(e), name: e.label }) || [MAIL_APPS, NO_COMPOSER].some((list) => oneOf(list, look.app) || oneOf(list, look.bundleId))) return null
  const by = (x) => x !== e && ((e.in && x.in === e.in) || near(x.frame, e.frame))
  const els = look.elements ?? []
  const box = (x) => x !== e && isBox({ role: boxRole(x), name: x.label })
  if (els.some((x) => by(x) && box(x) && !AREA.test(boxRole(x)))) return null
  const others = els.filter((x) => box(x) && gap(x.frame, e.frame) > 0)
  const alone = !others.some(by)
  const sends = els.filter((x) => roleOf(x) === 'button' && COMPOSER.test(String(x.label ?? '')) && (near(x.frame, e.frame) || (alone && by(x))) && !others.some((o) => gap(x.frame, o.frame) < gap(x.frame, e.frame)))
  return sends.sort((a, b) => gap(a.frame, e.frame) - gap(b.frame, e.frame))[0]?.label ?? null
}
/** Review S5R2 M1: the document editors whose main text area only adds a line on Return. A code editor's terminal and its chat box are text areas too. */
const DOC_EDITORS = ['textedit', 'notes', 'pages', 'bbedit', 'coteditor', 'obsidian']
/**
 * S5R2 (plan 2H): whether Return typed into `e`, a part of `look` (the app's look; none is a no), only adds a line: the text area
 * of a document editor that is no private app and no chat, whose words and container's say no terminal, console, chat, prompt,
 * ask or message, with no Send, Post, Reply, Comment or Submit button beside it or in its container (review S5R2 M1).
 */
export const returnAddsLine = (app, look, e) =>
  Boolean(look && e && String(look.app ?? '').toLowerCase() === String(app ?? '').toLowerCase() && (look.elements ?? []).includes(e)) &&
  !privateApp(app) && oneOf(DOC_EDITORS, app) && !chatApp(app, look) && AREA.test(boxRole(e)) &&
  !RUNS_RETURN.test([e.label, e.in, e.roleDescription].join(' ')) &&
  !look.elements.some((x) => roleOf(x) === 'button' && COMPOSER.test(String(x.label ?? '')) && (near(x.frame, e.frame) || (Boolean(e.in) && x.in === e.in)))
/** A one-line text field a web form's Return submits from: not the address bar, not a search. */
const oneLine = (thing) => /text ?field/i.test(String(thing?.role ?? '')) && !/address|url|location|search/i.test(String(thing?.name ?? ''))
/** Return on a Finder row starts a rename, not a press (Round 4 bench): the row's name is a file's, never a button's. */
const finderRename = (app, role) => /^finder$/i.test(String(app ?? '')) && /^(?:ax)?(?:outline ?row|row|cell|icon)$/i.test(String(role ?? ''))
/**
 * Review S5R2 H1: a type whose value holds a line break presses Return (Sundial.app types a line break as key 36): judged as that
 * type, then key return at its thing. `returns` marks both, so a second pass leaves them as they are.
 */
export const withReturns = (plans) => (Array.isArray(plans) ? plans : []).flatMap((p) => (p?.verb === 'type' && !p.returns && /[\r\n]/.test(String(p.command?.value ?? ''))
  ? [{ ...p, returns: true }, { verb: 'key', app: p.app, returns: true, ...(p.inWindow ? { inWindow: p.inWindow } : {}), ...(p.command?.ref || p.thing?.role || p.thing?.name ? { thing: p.thing ?? {} } : {}), command: { value: 'return', ...(p.command?.ref ? { ref: p.command.ref, look: p.command.look } : {}) } }]
  : [p]))
/** The app of a call's first Return, Enter or Space step, as the plan reads it: index.js then reads where its last look has the keyboard. */
export const enterApp = (plans) => withReturns(plans).find((p) => p?.verb === 'key' && (ENTER_KEYS.has(keyOf(p.command?.value)) || RETURNS.has(keyOf(p.command?.value))))?.app
/** Which look says where the keyboard is in `app`: the last look when it is of that app (none when refused), else this chat's last act result there, its after-look (run 145). */
export function keyboardLook(state, session, app) {
  if (!app) return null
  const look = state?.marks?.lastLook
  if (look?.app === app) return look.refused ? null : { id: look.id, at: look.at }
  const step = state?.marks?.chats?.[session ?? '']?.step
  return step?.app === app ? { id: step.id, field: 'after' } : null
}
/**
 * Run 234 T25: the words of a web form's final button, the first `look` shows (a page's Return in a text field presses its
 * form's first submit button, Send here), or null. Only in a browser: a native window's default button is not in the look.
 * S5R1: with a `field`, only a button in its own container or next to it (another section's Update is not its form's); a field
 * with no container is read against the whole page, which errs toward asking.
 */
export const formFinal = (look, field) => {
  if (!oneOf(BROWSERS, look?.app)) return null
  const ours = (e) => !field?.in || e.in === field.in || near(e.frame, field.frame)
  return (look.elements ?? []).find((e) => roleOf(e) === 'button' && e.enabled !== false && finalWord(e.label) && ours(e))?.label ?? null
}
/**
 * The plans the gate judges (index.js): the thing `seen`, the keyboard look of the Return's app, has the keyboard in goes first;
 * each key step there carries `seen`'s form final and whether it is a chat (`chat`); a message box `seen` shows its Send beside
 * carries that button's words (`thing.send`, composerFinal); a native part that passes Return on (a one-line field, a checkbox,
 * a row, a button), the words of the default button its Return presses (`thing.default`, '' when it shows none; defaultFinal).
 * S5R1: when nothing readable holds the keyboard, each key step carries that button's words as `press`. S5R2: when `seen` shows a
 * Save or Open panel in front (savePanel), each key step carries `panel`; S5R4: so does each after an open-panel.
 */
export function judgedPlans(given, seen) {
  // S5R4: the steps after an open-panel (screen-save.js openPanel) run only when a fresh look shows the app's Save panel: judged in
  // that panel (each key step `panel`), never on `seen`, the look from before it. The open-panel itself picks no final.
  const after = (p, i, all) => p?.verb !== 'open-panel' && all.slice(0, i).some((q) => q?.verb === 'open-panel' && q.app === p?.app)
  const steps = withReturns(given).map((p, i, all) => (after(p, i, all) ? { ...p, opened: true, ...(p.verb === 'key' ? { panel: true } : {}) } : p))
  if (!seen) return steps
  const held = seen.elements?.find((e) => e.ref === seen.focused)
  // S5R3: a Replace (or any final) button in the look is a confirmation over the panel: judged as any default button, never as the panel.
  const [form, chat, panel] = [formFinal(seen), chatApp(seen.app, seen), savePanel(seen) && !(seen.elements ?? []).some((e) => roleOf(e) === 'button' && e.enabled !== false && finalWord(e.label))]
  const lone = held ? null : defaultFinal(seen, null)
  const elementOf = (p) => (seen.elements ?? []).find((e) => (p?.command?.ref ? e.ref === p.command.ref && p.command.look === seen.id : p?.thing?.name && e.label === p.thing.name && roleOf(e) === p.thing.role))
  const mark = (p, e = elementOf(p)) => {
    if (p?.app !== seen.app || p.opened) return p
    const [send, press] = e ? [composerFinal(seen, e), defaultFinal(seen, e)] : []
    // S5R1: a web composer the look shows as a settable group is judged as the text area it is.
    const role = e && boxRole(e) !== roleOf(e) ? boxRole(e) : null
    // S5R1: a page's one-line field carries its own form's final ('' when none): the page-wide `form` is for a field nobody resolved.
    const own = form !== null && e && oneLine({ role: roleOf(e), name: e.label }) ? (formFinal(seen, e) ?? '') : null
    const thing = { ...p.thing, ...(role ? { role } : {}), ...(send ? { send } : {}), ...(press ? { default: String(press.label ?? '') } : {}), ...(own !== null ? { form: own } : {}) }
    const key = p.verb === 'key' ? { ...(form ? { form } : {}), ...(chat ? { chat } : {}), ...(panel ? { panel } : {}), ...(lone ? { press: String(lone.label ?? '') } : {}) } : {}
    return { ...p, ...(send || press || role || own !== null ? { thing } : {}), ...key }
  }
  return [...(held ? [mark({ verb: 'keyboard', app: seen.app, ...(seen.window ? { inWindow: seen.window } : {}), thing: { role: roleOf(held), name: held.label } }, held)] : []), ...steps.map((p) => mark(p))]
}
export const oneOf = (list, app) => String(app ?? '').toLowerCase().split(/[^a-z0-9]+/).some((word) => list.includes(word))
/** Bundle ids whose words do not hold the app's name, read as that name. */
const BUNDLES = { 'com.apple.mobilesms': 'Messages', 'com.apple.ichat': 'Messages' }
/** The URL schemes that open an app, read as that app's name. */
const SCHEMES = { messages: 'Messages', sms: 'Messages', imessage: 'Messages', facetime: 'FaceTime', 'facetime-audio': 'FaceTime', tel: 'FaceTime', whatsapp: 'WhatsApp', tg: 'Telegram', signal: 'Signal', sgnl: 'Signal', mailto: 'Mail', message: 'Mail', slack: 'Slack', discord: 'Discord', zoommtg: 'Zoom', zoomus: 'Zoom', venmo: 'Venmo', paypal: 'PayPal', bitwarden: 'Bitwarden', onepassword: '1Password', 'x-apple-health': 'Health' }
const holds = (name) => privateApps().some((entry) => name.toLowerCase().includes(entry))
/** The same test Sundial.app applies before a look: a name (or a bundle id) that holds a private app's entry; or, whole, a name a private app goes by in any language (2026-11-17: Notities). */
export const privateApp = (app) => typeof app === 'string' && app !== '' && (holds(app) || holds(BUNDLES[app.toLowerCase()] ?? '') || privateAppName(app))
/** Whether a URL opens a private app by its scheme (`sms:`, `messages://`). */
const privateUrl = (url) => privateApp(SCHEMES[/^\s*([a-z][a-z0-9+.-]*):/i.exec(String(url ?? ''))?.[1]?.toLowerCase()] ?? '')
const KEY_WORDS = { command: 'cmd', meta: 'cmd', '⌘': 'cmd', control: 'ctrl', option: 'alt', opt: 'alt' }
const keyOf = (value) => {
  const parts = String(value ?? '').toLowerCase().split('+').map((part) => KEY_WORDS[part.trim()] ?? part.trim())
  return [...parts.slice(0, -1).sort(), parts.at(-1)].join('+')
}
const obj = (value) => {
  try {
    const x = typeof value === 'string' ? JSON.parse(value) : value
    return x && typeof x === 'object' ? x : {}
  } catch {
    return {}
  }
}
const appOf = (step, args) => obj(step.target).app ?? step.app ?? args?.app
/** Keys that only move, open or switch: all a step may press in a private app, where nothing shows where a key lands. */
const NAV_KEYS = new Set(['escape', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'page-up', 'page-down', 'home', 'end', 'cmd+tab', 'cmd+shift+tab', 'cmd+`', 'cmd+n', 'cmd+shift+n', 'cmd+t', 'cmd+o', 'cmd+,', ...'123456789'.split('').map((d) => `cmd+${d}`)])
const parsed = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isStep = (s) => {
  const x = typeof s === 'string' ? parsed(s) : s
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}
/** A screen_act `steps` as a list, or null: a JSON string (run 129), one key around it ({item: [...]}, {item: {...}}; run 133), or one
 * more layer (run 193: {item: {item: {...}}} ran as a bare open, and [[...]]). The gate and screen-tools read it here alike. */
export function stepList(steps, depth = 0) {
  const once = (x) => (typeof x === 'string' ? parsed(x) : x)
  const sent = once(once(steps))
  const [inner] = sent && typeof sent === 'object' && !Array.isArray(sent) && Object.keys(sent).length === 1 ? Object.values(sent) : []
  const x = inner === undefined ? sent : Array.isArray(inner) ? inner : typeof inner === 'object' ? [inner] : null
  const deeper = depth < 1 && Array.isArray(x) && x.length === 1 && (Array.isArray(x[0]) || (inner !== undefined && isStep(x[0]) && Object.keys(x[0]).length === 1)) ? stepList(x[0], depth + 1) : null
  return deeper ?? (Array.isArray(x) && x.every(isStep) ? x : null)
}
/** The steps of a screen_act call, one or many. */
const stepsOf = (args) => {
  // Run 69 T06: steps "" or [] is one act, as screen-tools runs it.
  const list = stepList(args?.steps)
  return (list?.length ? list : [args ?? {}]).map(obj)
}
/** {role: "key", label: "return"} is pressed as the key return (screen-tools keyStep), so it is judged as that key. */
const asKey = (step) => {
  const t = { ...step, ...obj(step.target) }
  return /^key$/i.test(String(t.role ?? '').trim()) ? { ...step, action: 'key', value: [t.label, t.text, step.value].find((k) => typeof k === 'string' && k.trim() !== '') } : step
}
/** One screen step puts text or keys somewhere: type, set-value (a value with no action), select (its cmd+c copies), or a key that is not navigation. */
function typingStep(raw) {
  const step = asKey(raw)
  const verb = typeof step.action === 'string' && step.action.trim() !== '' ? step.action.trim() : typeof step.value === 'string' ? 'set-value' : ''
  return verb === 'type' || verb === 'set-value' || verb === 'select' || verb === 'save-as' || verb === 'go-to-folder' || (verb === 'key' && !NAV_KEYS.has(keyOf(step.value)))
}
/**
 * Typing in a private app (live test 3, 2026-11-12: a mail typed blind went into Mail's search field). 'private', 'unnamed'
 * when the app a typing step acts in cannot be told, or null. `lookApp`: the app of the last look, which a ref step acts in.
 * `fill(step)`: the app screen_act sends a step with no app and no ref to (screen-tools filledApp), so it is judged in that app.
 */
export function blindTypingOf(toolName, args, lookApp, fill = () => undefined) {
  if (toolName !== 'screen_act') return null
  const apps = stepsOf(args).filter(typingStep).map((step) => appOf(step, args) ?? (obj(step.target).ref ?? step.ref ? lookApp : fill(step)))
  if (apps.some(privateApp)) return 'private'
  return apps.some((app) => typeof app !== 'string' || app === '') ? 'unnamed' : null
}
// --- a final: an act that cannot be taken back. It asks in every preset and every mode (owner, 2026-11-14) ---
// Its words, in every language, are final-words.js's one table (owner, 2026-11-17).
export { finalWord }
/**
 * Owner decision 2026-11-17: whether a screen_act presses a button whose words Gnomon does not know (no final's, no plain word's,
 * in any language; knownButton): such a press never counts toward acting alone and always asks. Read from the plan when there is
 * one (a ref's own name), else from the steps. A button with no words, or a ref's name, is unknown.
 */
export function unknownPress(toolName, args, plans = []) {
  if (toolName !== 'screen_act') return false
  const BUTTON = /^(?:ax)?button$|^$/i
  const presses = Array.isArray(plans) && plans.length
    ? plans.filter((p) => ['press', 'click', 'confirm'].includes(p?.verb) && BUTTON.test(String(p.thing?.role ?? ''))).map((p) => p.thing?.name)
    : stepsOf(args).map(asKey).map((s) => ({ s, t: { ...s, ...obj(s.target) } })).filter(({ s, t }) => (['press', 'click', 'confirm'].includes(s.action) || (!s.action && s.value === undefined && (t.label ?? t.text ?? s.find) !== undefined)) && BUTTON.test(String(t.role ?? ''))).map(({ s, t }) => t.label ?? t.text ?? s.find)
  return presses.some((words) => typeof words !== 'string' || looksLikeRef(words) || !knownButton(words))
}
/** Finder's Move to Trash, Delete Immediately and Empty Trash keys (cmd+backspace is also Don't Save in a save sheet). */
const DELETE_KEYS = new Set(['cmd+backspace', 'cmd+delete', 'alt+cmd+backspace', 'alt+cmd+delete', 'cmd+shift+backspace', 'cmd+shift+delete', 'alt+cmd+shift+backspace', 'alt+cmd+shift+delete'])
/** A field's label names what goes in it ("Confirm password", "Post code"), not a press. */
const FIELD = /field|text ?area|textbox|search|combo/i
/** The final one screen step takes, `{ kind, what?, key? }`, or null: its words start with a final's (`what`: those words), or it is a send key (in a mail app, a browser, or an app it does not name) or a delete key (`key`). */
function finalStep(raw, app) {
  const step = asKey(raw)
  const target = { ...step, ...obj(step.target) }
  const field = FIELD.test(String(target.role ?? ''))
  // A find step names its thing in words ("Send button"): it counts the same as a label.
  // A pick's value is the menu item it presses. A set-value or a typing step puts text in a field ("Delete the old ones"): not a press.
  // A set-value on a pop-up ref picks its item; the plan knows the ref's role, so finalOf reads that from the plan.
  const verb = typeof step.action === 'string' && step.action.trim() !== '' ? step.action.trim() : 'set-value'
  const what = [field ? null : target.label, field ? null : target.text, step.find, ['pick-menu', 'pick'].includes(verb) ? step.value : null].find(finalWord)
  if (what || step.action !== 'key') return what ? { kind: finalWord(what), what } : null
  const key = keyOf(step.value)
  if (SEND_KEYS.has(key) && (!app || oneOf(MAIL_APPS, app) || oneOf(BROWSERS, app) || oneOf(CHAT_APPS, app))) return { kind: 'send', key }
  return DELETE_KEYS.has(key) ? { kind: 'delete', key } : null
}
/** The addresses a To, Cc or Bcc field holds (a field so labelled, or a chip inside one), as a look or a step reads them. */
const TO_FIELD = /^\s*(?:to|cc|bcc)\b/i
const addresses = (items) => [...new Set(items.flatMap((e) => (TO_FIELD.test(String(e?.label ?? '')) || TO_FIELD.test(String(e?.in ?? '')) ? (`${e.label ?? ''} ${e.value ?? ''}`.match(new RegExp(EMAIL, 'g')) ?? []) : [])))]
/** The recipients a look of a compose window shows: the addresses in its To, Cc and Bcc fields. */
export const recipientsOf = (look) => addresses(look?.elements ?? [])

const Q = String.raw`\\?"(.*?)\\?"`
const EMAIL = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`
/** A script whose text is not in the command (a file, stdin, a shortcut, a workflow) can send anything. */
const opaqueScript = (command) => /\bshortcuts\s+run\b|\bautomator\b/.test(command) || (/\bosascript\b/.test(command) && !/\bosascript\b[^|;&\n]*\s-e\s|<<|\b(?:echo|printf)\b[^|;&]*\|\s*osascript\b/.test(command))
const SE_KEYS = { 36: 'return', 76: 'enter' }
const SE_MODS = { command: 'cmd', shift: 'shift', option: 'alt', control: 'ctrl' }
/** A System Events keystroke that is a send key: Send pressed blind, wherever the keys land. `keystroke return` is a key by its name (S5R1). */
const keystrokeSend = (command) =>
  [...command.matchAll(/\b(?:keystroke\s+(?:\\?"(.)\\?"|(return|enter)\b)|key code\s+(\d+))\s+using\s+\{?([a-z ,]+)\}?/gi)].some((m) =>
    SEND_KEYS.has(keyOf([...[...m[4].toLowerCase().matchAll(/(command|shift|option|control) down/g)].map((x) => SE_MODS[x[1]]), m[1] ?? m[2] ?? SE_KEYS[m[3]] ?? '?'].join('+'))),
  )
/** S5R1: a bare Return or Enter by System Events, AppleScript or JXA (key code 36 or 76, keystroke return, text & return): no modifier, so no new line. */
// JXA's keyCode(36, {using: ...}) is not read for its modifiers: it counts as a Return, which errs toward asking.
const SE_RETURN = /\bkey ?code\s*\(?\s*(?:36|76)\b(?!\s*\)?\s*using\b)|\bkeystroke\s+(?:return|enter|linefeed|\(\s*ascii character\s+(?:3|10|13)\s*\))(?!\s+using\b)|\bkeystroke\b[^\n;|]*?&\s*(?:return|linefeed)\b(?!\s+using\b)/i
/**
 * The final a bare Return by System Events takes, or null: pressed blind wherever the keyboard is. Into a chat (or a private
 * app) it sends: a blind Send. Into an editor, a terminal or a mail app it adds a line or runs what was typed. Anywhere else, or
 * with no app named, nothing shows what it lands on: a final-unknown, asked.
 */
function returnOf(command) {
  if (!SE_RETURN.test(command)) return null
  const apps = [...[...command.matchAll(/\b(?:application|app|process)\s*(?:id\s*)?\(?\s*\\?["']([^"'\\]+)/gi)].map((m) => m[1]), ...shellOpens(command)].filter((name) => name && !/^system events$/i.test(name))
  const chat = apps.find((app) => oneOf(CHAT_APPS, app) || privateApp(app))
  if (chat) return { kind: 'send', via: 'shell', blind: true, app: chat }
  if (apps.length && apps.every((app) => oneOf(NO_COMPOSER, app) || oneOf(MAIL_APPS, app))) return null
  return { kind: 'final-unknown', via: 'shell', blind: false, ...(apps.length ? { app: apps[0] } : {}), why: 'a Return sent by System Events lands wherever the keyboard is' }
}

/**
 * A shell command that sends mail or a message: AppleScript or JXA `send` to a mail app or a private app (Messages), a script it cannot read,
 * a send key by System Events, a mail tool with a recipient, sendmail, SMTP by curl. Its fields as far as the text shows them, or null.
 * `blind`: a send key by System Events, or a send from a private app (review 2026-11-15: nothing of a private app is seen, so nothing is sent from it).
 */
export function mailOf(command) {
  if (typeof command !== 'string' || command === '') return null
  const app = [...command.matchAll(/\b(?:application|app)\s*(?:id\s*)?\(?\s*\\?["']([^"'\\]+)/gi)].map((m) => m[1]).find((name) => oneOf(MAIL_APPS, name) || privateApp(name))
  const script = app !== undefined && /\bsend\b/i.test(command)
  const blind = keystrokeSend(command) || (script && privateApp(app))
  const tool = /(?:^|[\s|;&(`])(?:mailx?|mutt|neomutt|msmtp|ssmtp|swaks)\s/.test(command) && (/\s-s\s/.test(command) || new RegExp(EMAIL).test(command))
  if (!script && !blind && !tool && !opaqueScript(command) && !/\bsendmail\b|\bsmtps?:\/\//.test(command)) return null
  const recipients = (kind) => [...command.matchAll(new RegExp(String.raw`\b${kind} recipient\b[^{}]*\{[^}]*?address\s*:\s*${Q}`, 'gi'))].map((m) => m[1])
  const subject = new RegExp(String.raw`\bsubject\s*:\s*${Q}`, 'i').exec(command)?.[1] ?? /\b(?:mailx?|mutt|neomutt)\b[^|;&]*?\s-s\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)?.slice(1).find((x) => x !== undefined)
  return {
    app: app ?? null,
    to: script ? recipients('to') : [...command.matchAll(new RegExp(EMAIL, 'g'))].map((m) => m[0]),
    cc: recipients('cc'),
    bcc: recipients('bcc'),
    subject: subject ?? null,
    body: new RegExp(String.raw`\bcontent\s*:\s*${Q}`, 'i').exec(command)?.[1] ?? null,
    ...(blind ? { blind: true } : {}),
  }
}

/** What a mail a shell command sends puts in front of the owner before their yes: to, cc, subject, body. '' when it sends none. */
export function mailLine(command) {
  const mail = mailOf(command)
  if (mail === null) return ''
  const cut = (text, n) => JSON.stringify(text.length > n ? `${text.slice(0, n)}…` : text)
  return [
    `To: ${mail.to.join(', ') || 'not readable in the command'}`,
    mail.cc.length ? `Cc: ${mail.cc.join(', ')}` : null,
    mail.bcc.length ? `Bcc: ${mail.bcc.join(', ')}` : null,
    `Subject: ${mail.subject === null ? 'not readable in the command' : cut(mail.subject, 200)}`,
    `Body: ${mail.body === null ? 'in the command above' : cut(mail.body, 800)}`,
  ].filter(Boolean).join(' · ')
}

/** A web_act's final: its `because` says send, the element it presses is named as a final, or it types text and presses Enter in a field that is not a search (a send). */
function webFinal(args, element) {
  const name = String(element?.name ?? '')
  if (/\bsend\b/i.test(String(args?.because ?? ''))) return 'send'
  const kind = FIELD.test(String(element?.role ?? '')) ? null : finalWord(name)
  if (kind) return kind
  return args?.submit === true && String(args?.text ?? '').trim() !== '' && !/search|zoek|find|query/i.test(`${element?.role ?? ''} ${name}`) ? 'send' : null
}

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
/**
 * A shell command that deletes: rm, rmdir, unlink, trash, find -delete, a move into the Trash, or a Finder delete or Empty Trash by AppleScript.
 * An rm inside quoted text (`echo "rm it"`) is an argument, unless the command runs its quoted text as a shell (`sh -c`, `eval`, `do shell script`).
 */
const shellDelete = (command) => {
  const runs = /\b(?:ba|z|da)?sh\s+-c\b|\beval\b|\bxargs\b|\bdo shell script\b/.test(command)
  return /(?<!\bgit)(?:^|[\s|;&(`"'])(?:rm|rmdir|unlink|srm|trash)\s/.test(runs ? command : command.replace(QUOTED, ' ARG ')) || /\bfind\b[^|;&\n]*\s-delete\b|\bmv\b[^|;&\n]*\.Trash\b/.test(command) || (/\bfinder\b/i.test(command) && /\b(?:delete|empty\s+(?:the\s+)?trash)\b/i.test(command))
}
/** The apps a shell command opens or brings to the front: `open -a` or `-b`, an `.app` path, a URL scheme (`open sms:`, `open location "imessage:"`), an AppleScript or JXA activate, launch or reopen. */
function shellOpens(command) {
  const opens = [...command.matchAll(/\bopen\b[^|;&\n]*?\s-[ab]\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)].map((m) => m[1] ?? m[2] ?? m[3])
  const bundles = [...command.matchAll(/\bopen\b[^|;&\n]*?([^\s"'/]+)\.app\b/g)].map((m) => m[1])
  const schemes = /\bopen\b/.test(command) ? [...command.matchAll(/(?:^|[\s"'(=])([a-z][a-z0-9+.-]*):/gi)].map((m) => SCHEMES[m[1].toLowerCase()] ?? '') : []
  const told = /\b(?:activate|launch|reopen)\b/i.test(command) ? [...command.matchAll(/\b(?:application|app)\s*(?:id\s*)?\(?\s*\\?["']([^"'\\]+)/gi)].map((m) => m[1]) : []
  return [...opens, ...bundles, ...schemes, ...told]
}
/**
 * Whether a shell command names a private app's own data: Messages' chat.db, or a folder under ~/Library whose name, or the name
 * of the folder in it, holds a private app's (`Library/Messages`, `Library/Mail`, `Library/Application Support/Signal`, `Library/Containers/com.apple.mail`).
 */
export function privateData(command) {
  if (/\bchat\.db\b/i.test(command)) return true
  const tokens = (command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|(?:\\.|[^\s"'])+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, '').replace(/\\ /g, ' '))
  return tokens.some((token) => token.includes('Library/') && token.split('Library/').slice(1).some((rest) => rest.split('/').slice(0, 2).some(privateApp)))
}

/**
 * Whether a call takes a final step: `{ kind, via, blind, unnamed?, app?, to? }` or null. `app` and `to` are for the ask; the record keeps `bare()` of it.
 * kind: send | submit | delete | discard | pay | post | update | overwrite | archive | leave | block | share | transfer | merge | answer, or final-unknown (Return after a key moved the keyboard). `blind`: a final where nothing can be seen (a private app, a System Events key).
 * `unnamed`: a screen final with no app named. `to`: a screen send's readable recipients.
 * `webElement(page, ref)` is the element a web_act ref names in the page's last reading. `plans`: the steps as screen-tools resolved them
 * from the look (a ref's own name), and `recipients` the addresses the last look shows in To, Cc and Bcc.
 */
/** A declared tool's arguments as its ask shows them (`key: value; ...`, 400 characters), and the values a send goes to. */
const argsLine = (args) => {
  const line = Object.entries(obj(args)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ')
  return line.length > 400 ? `${line.slice(0, 400)}…` : line
}
const TO_KEYS = /^(?:recipients?|to|cc|bcc|channel|user|participants|emails?)$/i
const toOf = (args) => Object.entries(obj(args)).filter(([k]) => TO_KEYS.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())

export function finalOf(toolName, args, webElement = () => null, plans = [], recipients = []) {
  // A tool another plugin declared (gate-tools.js DECLARED_TOOLS: the bench's AgentDojo tools): its final kind as declared.
  if (DECLARED_TOOLS.has(toolName)) {
    const kind = DECLARED_TOOLS.get(toolName)
    return kind ? { kind, via: 'tool', blind: false, what: argsLine(args), ...(kind === 'send' ? { to: toOf(args) } : {}) } : null
  }
  if (toolName === 'bash' || GNOMON_TOOLS[toolName]?.shell === true) {
    const mail = mailOf(commandOf(args))
    if (mail) return { kind: 'send', via: 'shell', blind: mail.blind === true }
    return returnOf(commandOf(args)) ?? (shellDelete(commandOf(args)) ? { kind: 'delete', via: 'shell', blind: false } : null)
  }
  if (toolName === 'web_act') {
    const element = webElement(String(args?.page ?? ''), Number(args?.ref))
    const kind = webFinal(args, element)
    return kind ? { kind, via: 'web', blind: false, ...(element?.name ? { what: String(element.name) } : {}) } : null
  }
  if (toolName !== 'screen_act') return null
  // A ref press names nothing in its arguments: its name is the look's, as the plan read it.
  // A set-value or pick on a pop-up presses the item its value names.
  // Run 138: Return, Enter or Space presses the thing the keyboard is in: the one an earlier step focused or selected, else
  // the one the last look or act result has the keyboard in (index.js puts it first, as verb 'keyboard'). Any other step can move the keyboard.
  // Run 145: a key that moves the keyboard (tab, shift+tab, an arrow; any key but Return itself) and then Return lands on a part nobody
  // read: that asks, fail-closed. Only typing known to land in a field clears that: a type or set-value whose thing is a field, or one
  // after a focus or select on a field, the look's keyboard in a field, or cmd+f or cmd+l. A bare type on a button goes nowhere.
  // Run 154: a caret key (cmd+down, an arrow, home) while the keyboard is known to be in a field moves inside that field, not off it:
  // Return then adds a line. The same arrow outside a field (a list) moves the selection, so it still asks. Up, down and the page keys
  // count only in a text area (multi-line): in a search field or a combo box they pick a suggestion (review, Round 5).
  // Set 2 R1: an editing key (select all, copy, paste, undo) leaves the keyboard where it is; cmd+t or cmd+n in a browser, or cmd+n in an
  // editor (opensField), opens a new tab or document with the keyboard in its field (run 154: a new Obsidian note; run 150: Zen's address bar).
  // The ask names what the keyboard was last known to be on (`last`) and the key that moved it off (`by`); a delete key names the
  // thing it deletes (Finder: the selected file) when nothing moved the keyboard since.
  // Run 234 T25: a key with a ref (or a thing by name) goes to that thing first: Return on a ref to Send is a press on Send,
  // wherever the keyboard was. With no plan, a ref step's thing is unread: its Return is a final-unknown.
  const seq = withReturns(Array.isArray(plans) && plans.length ? plans : stepsOf(args).map(asKey).map((s) => { const ref = obj(s.target).ref ?? s.ref; return { verb: s.action, app: appOf(s, args), ...(ref ? { thing: {} } : {}), command: { value: s.value, ...(ref ? { ref } : {}) } } }))
  const { pressed } = seq.reduce(({ aim, moved, field, area, single, box, last, by, pressed, open, goTo }, p) => {
    const key = p?.verb === 'key' ? keyOf(p.command?.value) : null
    const own = key !== null && (p.command?.ref || p.thing?.role || p.thing?.name) ? p : null
    if (own) [aim, moved, field, area, single, box, last, by] = [own, false, FIELD.test(String(own.thing?.role ?? '')), AREA.test(String(own.thing?.role ?? '')), oneLine(own.thing), FIELD.test(String(own.thing?.role ?? '')) ? own.thing : null, own.thing?.name || last, null]
    const enter = key !== null && ENTER_KEYS.has(key)
    // S5R1: Return (or cmd+Return) in a chat's message box sends: `box`, the field the keyboard is in, shows its Send, or the app is a chat.
    const ret = key !== null && RETURNS.has(key)
    const chat = p?.chat === true || oneOf(CHAT_APPS, p?.app)
    const caret = key !== null && (caretKey(key) === 'vertical' ? area : caretKey(key) === 'line' && field)
    const opens = opensField(key, p.app, p.panel === true)
    // Run 212 T19: a click or press on a field or a text area puts the keyboard in it, as a focus does.
    const aimed = ['focus', 'select', 'keyboard'].includes(p?.verb) || (['click', 'press'].includes(p?.verb) && FIELD.test(String(p?.thing?.role ?? '')))
    const inField = FIELD.test(String(p?.thing?.role ?? '')) || (['type', 'set-value'].includes(p?.verb) && field)
    const inArea = p?.thing?.role ? AREA.test(String(p.thing.role)) : ['type', 'set-value'].includes(p?.verb) && area
    // Fail closed: Return on a thing with no words (not a field) presses what nobody read. In a browser, Return in a one-line text
    // field (not the address bar, not a search) presses the form's final (`p.form`, judgedPlans).
    const words = typeof aim?.thing?.name === 'string' && aim.thing.name.trim() !== '' && !looksLikeRef(aim.thing.name) ? aim.thing.name : null
    // S5R1: the default button a Return presses: from a native one-line field, from a part that is no field (a checkbox, a row,
    // a popup, a button), or, outside a chat, from nothing readable when no key moved the keyboard (`p.press`, judgedPlans).
    // S5R1: the form final of the field the keyboard is in, when the look resolved it; else the page's (judgedPlans).
    const formed = typeof box?.form === 'string' ? box.form : p.form
    const dflt = typeof box?.default === 'string' ? box.default : aim ? (FIELD.test(String(aim.thing?.role ?? '')) ? undefined : aim.thing?.default) : !moved && !field && !chat ? p.press : undefined
    // S5R3: in a Save or Open panel the look shows in front (`p.panel`), Return presses the panel's own Save or Open, which writes a
    // new file or opens one, wherever the keyboard moved inside it (a Return in its "Go to the folder" field only moves it). A save
    // over a file that is there asks as an overwrite (the panel then shows Replace); a Return after the panel closed in this call
    // lands on what nobody read.
    const panelled = enter && key !== 'space' && p.panel === true
    const over = ['press', 'click'].includes(p?.verb) ? savesOver(p.given?.saveTo) : null
    const one = panelled ? (open ? null : { app: p.app, unknown: true, why: 'the Save or Open panel closed with a step before it, and nothing read what is in front after' })
    : over ? { app: p.app, kind: 'overwrite', what: `Save, over the file already at ${over}` }
    : enter && aim && finderRename(p.app ?? aim.app, aim.thing?.role) ? null
    : enter && single && formed && key !== 'space' ? { app: p.app ?? aim?.app, role: 'button', label: formed, ...(last ? { on: last } : {}), key }
    // A final by the default button's words, unread when it shows none; an OK-like default presses no final, unless the part the
    // keyboard is on is itself named as one (Return on a focused Delete: asked, whichever of the two it presses).
    : enter && key !== 'space' && typeof dflt === 'string' ? (finalWord(dflt) ? { app: p.app ?? aim?.app, role: 'button', label: dflt, on: dflt, key } : dflt.trim() === '' || looksLikeRef(dflt) ? { app: p.app ?? aim?.app, unknown: true, why: 'the default button a Return presses shows no words' } : !box && finalWord(words) ? { app: p.app ?? aim.app, role: aim.thing?.role, label: words, on: words, key } : null)
    : ret && isBox(box) && (box.send || chat) ? { app: p.app ?? aim?.app, kind: finalWord(box.send) ?? 'send', what: box.send || 'Send', key, ...(box.name || last ? { on: box.name || last } : {}), ...(talkOf(box.name) ? { to: talkOf(box.name) } : {}) }
    : enter && aim && !words && !FIELD.test(String(aim.thing?.role ?? '')) ? { app: p.app ?? aim.app, unknown: true, why: 'what it lands on shows no words' }
    : enter && aim ? { app: p.app ?? aim.app, role: aim.thing?.role, label: aim.thing?.name, on: aim.thing?.name, key }
    // S5R3 (run 248 T19, T21): save-as or go-to-folder with no panel in the look: its keys land in the document, so it says why.
    : enter && moved && p.given?.goTo ? { app: p.app, unknown: true, why: `the last look of ${p.app} shows no Save or Open panel in front: open it and look before save-as or go-to-folder` }
    : enter && moved ? { app: p.app, unknown: true, last, by }
    // Fail closed: in a chat, a Return whose box nobody read may send.
    : ret && chat && !aim && !field ? { app: p.app, unknown: true, why: 'in a chat Return sends, and no look shows what the keyboard is in' }
    : key !== null && DELETE_KEYS.has(key) ? { app: p.app, kind: 'delete', key, last, ...(moved ? { by } : {}) }
    // Doc 27 section 3: a click at a point or a drag is judged by what lies under the point (or the drop), unknown when it shows no words.
    : p?.point || p?.verb === 'drag' ? pointFinal(p)
    : ['press', 'click', 'confirm', 'pick-menu'].includes(p?.verb) ? { app: p.app, role: p.thing?.role, label: p.thing?.name, ...(p.verb === 'pick-menu' ? { last, ...(moved ? { by } : {}) } : {}) }
    : ['set-value', 'pick'].includes(p?.verb) && /pop ?up|menu/i.test(String(p.thing?.role ?? '')) ? { app: p.app, role: 'menu item', label: String(p.command?.value ?? '') }
    : null
    const kept = enter || caret || EDIT_KEYS.has(key) || p?.verb === 'wait'
    const typed = ['type', 'set-value'].includes(p?.verb)
    // What takes the keyboard or the selection: a focus or select, typing into a named thing, a click on a row, a cell or a field.
    const takes = aimed || typed || Boolean(own) || (['press', 'click'].includes(p?.verb) && /row|cell|icon|field|text ?area|combo|search/i.test(String(p.thing?.role ?? '')))
    const named = takes && typeof p?.thing?.name === 'string' && p.thing.name !== '' ? p.thing.name : null
    return {
      aim: aimed || (own && kept) ? p : kept ? aim : null,
      moved: opens ? false : key !== null && !kept ? true : aimed ? false : typed ? moved && !inField : kept ? moved : false,
      field: key !== null ? opens || FIND_KEYS.has(key) || (kept && field) : aimed || typed ? inField : p?.verb === 'wait' && field,
      area: key !== null ? kept && area : aimed || typed ? inArea : p?.verb === 'wait' && area,
      single: key !== null ? !opens && !FIND_KEYS.has(key) && kept && single : aimed || typed ? (p?.thing?.role ? oneLine(p.thing) : typed && single) : p?.verb === 'wait' && single,
      box: key !== null ? (kept ? box : null) : aimed || typed ? (FIELD.test(String(p?.thing?.role ?? '')) ? p.thing : typed && field ? box : null) : p?.verb === 'wait' ? box : null,
      last: opens ? null : named ?? last,
      by: key !== null && !kept ? key : named ? null : by,
      // S5R2: the window of the look that holds the step's thing (or the keyboard's), for the ask.
      open: open && !(enter && !goTo) && key !== 'escape' && !(['press', 'click', 'confirm', 'pick-menu'].includes(p?.verb) && !/row|cell|icon|field|text ?area|combo|search|outline/i.test(String(p.thing?.role ?? ''))),
      goTo: opens && p.panel === true ? true : key !== null && !kept ? false : !enter && goTo,
      pressed: one ? [...pressed, { ...one, ...((p.inWindow ?? aim?.inWindow) ? { inWindow: p.inWindow ?? aim.inWindow } : {}) }] : pressed,
    }
  }, { aim: null, moved: false, field: false, area: false, single: false, box: null, last: null, by: null, pressed: [], open: true, goTo: false })
  // S5R2: a step with no app goes to the app screen_act fills in (this chat's last look of the turn): judged there when every
  // planned step goes to that one app (4 denies in runs 211-221). No plan, or two apps, and it stays unnamed.
  const only = [...new Set(seq.map((p) => p?.app).filter(Boolean))]
  const filled = Array.isArray(plans) && plans.length && only.length === 1 ? only[0] : undefined
  // Review S5R2 M2: what an ask says of where a final lands (its window, what it is on, the keyboard's last thing, why, to whom)
  // comes from the plan's own entries (`pressed`, read from the looks), never from a field the model put on a step.
  const steps = [...stepsOf(args).map((step) => ({ step, app: appOf(step, args) ?? filled, own: {} })), ...pressed.map((step) => ({ step, app: step.app, own: step }))]
  const finals = steps.map(({ step, app, own }) => {
    const hit = own.unknown ? { kind: 'final-unknown' } : own.kind ? own : finalStep(step, app)
    return { app, kind: hit?.kind, what: hit?.what, key: hit?.key ?? own.key, on: own.on, last: own.last, by: own.by, why: own.why, to: own.to, inWindow: own.inWindow }
  }).filter((f) => f.kind)
  if (finals.length === 0) return null
  const [{ kind }] = finals
  // The words of the first final of its kind, and where it lands from any step of that kind (a delete key names its file in the plan, not the arguments).
  const words = finals.find((f) => f.kind === kind && (f.what || f.key)) ?? {}
  const lands = finals.find((f) => f.kind === kind && (f.on || f.last || f.by || f.why)) ?? {}
  const app = finals.find((f) => f.app)?.app
  const to = kind === 'send' ? [...new Set([...addresses(stepsOf(args).map((step) => ({ ...step, ...obj(step.target) }))), ...recipients, ...finals.flatMap((f) => (f.to ? [f.to] : []))])] : []
  const said = Object.fromEntries(Object.entries({ what: words.what, key: words.key, on: lands.on, last: lands.last, by: lands.by, why: lands.why, refWindow: finals.find((f) => f.kind === kind && f.inWindow)?.inWindow }).filter(([, v]) => typeof v === 'string' && v !== ''))
  return { kind, via: 'screen', blind: finals.some((f) => privateApp(f.app)), ...(finals.some((f) => !f.app) ? { unnamed: true } : {}), ...(app ? { app } : {}), ...(to.length ? { to } : {}), ...said }
}

export const EFFECT = { send: 'sends a mail or a message', submit: 'submits a form (Submit, Place order, Confirm order)', delete: 'deletes (Delete, Move to Trash, Remove, Erase, Unsend)', discard: "discards unsaved changes (Don't Save, Discard)", pay: 'pays or buys', post: 'posts in public', update: 'installs an update or restarts (Update, Install, Restart Now)', overwrite: 'overwrites what is there (Replace, Overwrite)', archive: 'archives (Archive)', leave: 'leaves or unsubscribes (Leave, Unsubscribe)', block: 'blocks or revokes (Block, Revoke)', share: 'shares with others (Share, Invite)', transfer: 'transfers money or ownership (Transfer)', merge: 'merges into a shared branch (Merge)', answer: 'answers for you (Approve, Accept, Decline)', 'final-unknown': 'Return lands on a part Gnomon cannot read for certain (the keyboard moved first)' }
export const askFirst = (final) => `${EFFECT[final.kind]}${final.kind === 'final-unknown' ? ': what it presses may not be taken back' : ', which cannot be taken back'}, so it asks you first.`
const ABSOLUTE = /(?:^|[\s=])(["']?)(\/[^\s"';|&<>]+)\1/g
const KIND_WORDS = { send: 'sends a mail or a message', submit: 'submits a form', delete: 'deletes', discard: 'discards unsaved changes', pay: 'pays or buys', post: 'posts in public', update: 'installs an update or restarts', overwrite: 'overwrites what is there', archive: 'archives', leave: 'leaves or unsubscribes', block: 'blocks or revokes', share: 'shares with others', transfer: 'transfers money or ownership', merge: 'merges into a shared branch', answer: 'answers for you' }
/**
 * Set 2 R1: what a final does, in words the rig and the owner can check: its kind, its target (the control's own words, the key and
 * what it lands on, the file Finder has selected, the files a shell command deletes), and the app and window it happens in.
 */
function finalWhat(final, window, touched) {
  const where = final.app ? ` in ${final.app}${window ? ` (window ${quote(window)})` : ''}` : final.via === 'web' ? ' on a web page' : ''
  const moved = final.by ? (final.last ? `the keyboard was last on ${quote(final.last)}, then ${final.by} moved it` : `${final.by} moved the keyboard first`) : ''
  if (final.kind === 'final-unknown') return `this Return${where} lands on a part Gnomon cannot read for certain (${moved || final.why || 'the keyboard moved first'}): what it presses may not be taken back`
  if (final.via === 'shell') return `this ${KIND_WORDS[final.kind]}${touched?.deletes.length ? ` ${touched.deletes.map(quote).join(', ')}` : ''} from the shell, which cannot be taken back`
  // A delete key or Move to Trash in Finder acts on the selection: named when nothing moved the keyboard off it since.
  if (final.kind === 'delete' && /^finder$/i.test(final.app ?? '') && !/empty/i.test(final.what ?? '')) return `this moves ${final.last && !final.by ? quote(final.last) : 'the selected items'} to the Trash${where}${moved ? ` (${moved})` : ''}, which cannot be taken back`
  // "Delete the message from Mira Bakker" deletes "the message from Mira Bakker"; any other control is named whole.
  const rest = final.kind === 'delete' ? String(final.what ?? '').replace(finalRe('delete'), '').replace(/^[\s:,-]+/, '').trim() : ''
  const how = final.on ? ` with ${final.key ?? 'return'} on ${quote(final.on)}` : rest ? ` ${quote(rest)}` : final.what ? ` with ${quote(final.what)}` : final.key ? ` with ${final.key}` : ''
  return `this ${KIND_WORDS[final.kind]}${how}${where}, which cannot be taken back`
}
/**
 * The ask the owner and the rig read for a final (index.js puts it on the ask; the record keeps the gate's reason, W3):
 * `Gnomon: this <kind> <target> in <App> (window "<title>"), … asks you first.` then the steps as the code reads them
 * (`Verb "thing" in App[: value]`, joined by `; then `), then behind ` · `: the recipients (`To: a, b`, or a shell mail's fields),
 * the absolute path of a delete or discard, what a shell command touches, the command (200 characters), and the tag `final: <kind>`.
 * `line`: screen-tools' step line; `command`: a shell call's command; `path`: the front document of the final's app; `window`: the
 * title of the window the last look of that app read, unless the final names the window of the look that holds its thing (S5R2,
 * `refWindow`: run 226's Send ask named another window of the same app).
 */
export function finalAsk(final, { line, command, path, window } = {}) {
  const shell = final.via === 'shell'
  const text = String(command ?? '')
  const touched = shell ? touchesOf(text) : null
  const paths = shell ? [...new Set([...text.matchAll(ABSOLUTE)].map((m) => m[2]))] : path ? [path] : []
  return [
    `Gnomon: ${finalWhat(final, final.refWindow ?? window, touched)}, so it asks you first.${line ? ` ${line}` : ''}`,
    final.kind !== 'send' ? null : shell ? mailLine(text) : `To: ${final.to?.length ? final.to.join(', ') : 'not readable on screen'}`,
    ['delete', 'discard'].includes(final.kind) && paths.length ? `Path: ${paths.join(', ')}` : null,
    shell ? touchesLine(text) : null,
    shell ? commandLine(text) : null,
    `final: ${final.kind}`,
  ].filter(Boolean).join(' · ')
}
/** An app an AppleScript or JXA text names as its object: `application "X"` or `application id "X"`, `tell app "X"`, a `process "X"`, `Application("X")`. */
const SCRIPT_APP = /\b(?:application\s+(?:id\s+)?|tell\s+app\s+(?:id\s+)?|(?:tell|application)\s+process\s+)\\?["']([^"'\\]+)|\bapplication\s*\(\s*\\?["']([^"'\\]+)/gi
/**
 * 2026-11-17: the apps a command's script addresses, when the command runs osascript (inline, a heredoc, a pipe or a file it also
 * writes): reading Notes by script is reading Notes. A name in a dialog's text, or a script nobody runs, addresses nothing.
 */
const scriptApps = (command) => (/\bosascript\b/.test(command) ? [...command.matchAll(SCRIPT_APP)].map((m) => m[1] ?? m[2]) : [])
/**
 * Whether a call opens, raises, reads or acts in a private app: a screen_act step in one (by name or bundle id, by the last look for a ref,
 * or the app it is filled in for) or a url step whose scheme opens one, or a shell command that opens one or names its data.
 */
export function privateOf(toolName, args, lookApp, fill = () => undefined) {
  if (toolName === 'bash' || GNOMON_TOOLS[toolName]?.shell === true) return [...shellOpens(commandOf(args)), ...scriptApps(commandOf(args))].some(privateApp) || privateData(commandOf(args))
  if (toolName !== 'screen_act') return false
  return stepsOf(args).some((step) => privateUrl(step.url) || privateApp(appOf(step, args) ?? (obj(step.target).ref ?? step.ref ? lookApp : fill(step))))
}
