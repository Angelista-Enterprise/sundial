// S5R2 (plan 2B): a Save or Open panel steered by its own "Go to the folder" field. Run 245 T21: Gnomon could not save a copy
// into a sibling folder: the Where pop-up listed only Drafts and its ancestors, the column browser stopped answering, and Return
// or cmd+s wrote no file. Every Save and Open panel takes cmd+shift+g, a whole path and Return, whatever folder it remembers.
//
//   {app, action: "go-to-folder", value: "/the/folder"}       cmd+shift+g, the path, Return: the panel shows that folder
//   {app, action: "save-as", value: "/the/folder/name.ext"}   that, then the name (cmd+a, type) and a press on Save
//
// The steps are screen_act's own (planAll plans them like any other), so the gate judges each one; the Return in the go-to
// field is navigation only when the look shows the panel in front (gate-finals.js `opensField`). The Save step carries the
// whole path (`saveTo`), which the save proof checks on disk (screen-proof.js).
//
// S5R4 (runs 248 T19 and T21): save-as was sent with no panel open (a plain document, or the title bar's rename popover), and its
// cmd+shift+g went into the document. When the last look of the app shows no panel, save-as opens it first: one `open-panel` step
// (openPanel) picks the item the app's own File menu lists (list-menu, then pick-menu: no posted keys), and the steps after it run
// only when a fresh look shows the panel. The gate judges them in that panel (gate-finals.js judgedPlans); opening it is no final.
//
// S6 (doc 30, runs 250 to 253): posted keys and typed text never reached the out-of-process panel (about 19 go-to tries, none
// landed), while clicks, presses and set-value did, and both save-where passes clicked through the column browser. So by default
// a panel step sends no key: one `panel-go` step (panelGo) walks the panel to the folder by its sidebar and folder columns, a
// fresh look after every click, sets the name by set-value, and the Save press is its own step (the gate judges it; a file that
// is there asks as an overwrite). The cmd+shift+g chain above stays behind experiments.screenPanelKeys, for when keys reach the
// panel (Swift round 2B).
//
// Named exports only.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { keyboardLook } from './gate-finals.js'
import { actionFor, lookOf, roleOf, savePanel } from './screen-look.js'

const VERBS = /^(?:save-as|go-to-folder)$/
/** Whether a step (or a one-step call) is a panel step. */
export const panelStep = (step) => VERBS.test(String(step?.action ?? '').trim())
const bad = (why) => ({ error: `invalid arguments: ${why}` })
/** An absolute path, or one under ~/, with no trailing slash (the root alone stays). */
const pathOf = (value) => {
  const path = String(value ?? '').trim().replace(/(.)\/+$/, '$1')
  return /^(?:\/|~\/)/.test(path) && !/[\r\n]/.test(path) && path.length <= 1024 ? path : null
}

/**
 * One panel step as the steps it stands for, or `{ error }`. A step of any other kind is itself. `shown`: `{ app, panel }` of the
 * app's last look (panelIn); a save-as whose app shows no panel opens it first. `keys` (experiments.screenPanelKeys): the
 * cmd+shift+g chain; else one panel-go step (panelGo), then the Save press.
 */
export function panelSteps(raw, shown = null, keys = false) {
  if (!panelStep(raw)) return [raw]
  const { action, value, ...rest } = raw
  const save = action.trim() === 'save-as'
  const path = pathOf(value)
  if (!path) return bad(`${action.trim()} takes value, the whole path from / (or ~/): ${save ? '{app, action: "save-as", value: "/Users/me/Outbox/report.txt"}' : '{app, action: "go-to-folder", value: "/Users/me/Outbox"}'}`)
  const [folder, name] = save ? [dirname(path), basename(path)] : [path, '']
  if (save && (!/\.[^./]{1,8}$/.test(name) || /:/.test(name))) return bad('save-as takes the whole path of the file, its name with its extension last ("/Users/me/Outbox/report.txt")')
  const step = (more) => ({ ...rest, ...more })
  const open = save && shown?.panel === false ? [step({ action: 'open-panel', app: shown.app, value: path })] : []
  const app = shown?.app ?? rest.app
  if (!keys && !app) return bad(`${action.trim()} needs the app whose panel it is: {app: "TextEdit", action: "${action.trim()}", value: ${JSON.stringify(path)}}`)
  if (!keys) return [...open, step({ action: 'panel-go', app, value: folder, ...(save ? { name } : {}) }), ...(save ? [step({ role: 'button', label: 'Save', action: 'press', saveTo: path })] : [])]
  return [
    ...open,
    step({ action: 'key', value: 'cmd+shift+g' }),
    step({ action: 'key', value: 'cmd+a' }),
    step({ action: 'type', value: folder }),
    step({ action: 'key', value: 'return', goTo: folder }),
    ...(save ? [step({ action: 'key', value: 'cmd+a' }), step({ action: 'type', value: name }), step({ role: 'button', label: 'Save', action: 'press', saveTo: path })] : []),
  ]
}

/** S5R3: the whole path a save-as's Save writes (`saveTo`), when a file is already there (the gate asks it as an overwrite), else null. */
export const savesOver = (to) => {
  const path = typeof to === 'string' && to !== '' ? (to.startsWith('~/') ? join(homedir(), to.slice(2)) : to) : null
  return path && existsSync(path) ? path : null
}

const keyIs = (s, re) => s?.action === 'key' && re.test(String(s.value ?? '').replace(/\s/g, ''))
/** Doc 31 (run 255 T21): cmd+shift+g, a whole path (type or set-value) and Return, from `i`: that go-to-folder step, else null. */
const goChain = (list, i) => {
  const [a, b, c] = list.slice(i, i + 3)
  const apps = new Set([a, b, c].map((s) => s?.app).filter(Boolean))
  if (!keyIs(a, /^(?:cmd|command)\+shift\+g$/i) || !['type', 'set-value'].includes(b?.action) || !pathOf(b.value) || !keyIs(c, /^(?:return|enter)$/i) || apps.size > 1) return null
  const { action, value, ...rest } = a
  return { ...rest, action: 'go-to-folder', value: b.value }
}

/**
 * Doc 32 (run 258 T19): a go-to field (Finder's Go to Folder, a panel's) comes up holding the last path, and a path typed after
 * cmd+shift+g went in behind it. The step that puts a whole path there replaces what it holds: cmd+a before a type (`room`: the call
 * has room for one more step), replace on a set-value.
 */
const replacing = (s, go, room) => (s?.action === 'type' && pathOf(s.value) && room ? [{ ...(s.app ?? go.app ? { app: s.app ?? go.app } : {}), action: 'key', value: 'cmd+a' }, s] : s?.action === 'set-value' && pathOf(s.value) ? [{ ...s, replace: true }] : [s])

/**
 * A call's steps with each panel step spelled out, or `{ error }` naming the step that is wrong. `shown(app)`: panelIn. `keys`: panelSteps.
 * With no keys, a cmd+shift+g, path, Return chain sent to an app whose last look shows a panel is that go-to-folder (doc 31). Any other
 * cmd+shift+g: the path after it (past waits) replaces what the field holds (replacing).
 */
export async function panelList(list, shown = async () => null, keys = false) {
  const out = []
  for (let i = 0; i < list.length; i++) {
    const chain = keys ? null : goChain(list, i)
    const walk = chain && (await shown(chain.app))?.panel === true
    const raw = walk ? chain : list[i]
    const go = walk ? null : list.slice(0, i).findLast((s) => s?.action !== 'wait')
    const steps = keyIs(go, /^(?:cmd|command)\+shift\+g$/i) && !panelStep(raw) ? replacing(raw, go, list.length < 8) : panelSteps(raw, panelStep(raw) ? await shown(raw.app) : null, keys)
    if (steps.error) return { error: `step ${i + 1}: ${steps.error}` }
    out.push(...steps)
    if (walk) i += 2
  }
  return out
}

/** S5R4: `(app) => { app, panel }`: the app a save-as goes to (`fallback` when the step names none) and whether its last look, the one the gate reads (keyboardLook), shows a Save or Open panel; null with no app. */
export const panelIn = (state, session, readLook, fallback) => async (app) => {
  const name = app ?? fallback
  const at = name ? keyboardLook(state, session, name) : null
  return name ? { app: name, panel: savePanel(at ? lookOf(await readLook(at.id, at).catch(() => null)) : null) } : null
}

/** The plan of an `open-panel` step (planAll): no act of its own; openPanel runs it. */
export const openPlan = (given) => ({ verb: 'open-panel', app: given.app, thing: { name: 'Save panel' }, line: `Open the Save panel of ${given.app} by its File menu`, because: 'open the Save panel to save the file', command: {}, given })
/** The plan of a `panel-go` step: no act of its own; panelGo runs it. */
const goPlan = (given) => ({ verb: 'panel-go', app: given.app, thing: { name: String(given.value) }, line: `Go to ${JSON.stringify(given.value)} in the ${given.app} panel by its sidebar and folder columns${given.name ? `, and name the file ${JSON.stringify(given.name)}` : ''}`, because: 'go to the folder in the panel', command: {}, given })
/** The verbs of the panel's own steps, which run in code (panelRun), not as one act. */
export const OWN = ['open-panel', 'panel-go']
/** The plan of one of the panel's own steps (planAll). */
export const ownPlan = (given) => (given.action === 'open-panel' ? openPlan(given) : goPlan(given))
/** Runs one of the panel's own steps. */
export const panelRun = (plan, deps) => (plan.verb === 'open-panel' ? openPanel(plan, deps) : panelGo(plan, deps))

const ext = (name) => /\.([^./\s]{1,8})$/.exec(String(name ?? ''))?.[1]?.toLowerCase()
/**
 * The File menu items that open a Save panel, picked in this order, by their names as the app's own menu lists them, or null:
 * Save As (TextEdit lists it only as the Option variant; it is picked by name, no key held); else Duplicate then Save (the copy's
 * Save opens the panel); else Export, only when the file's extension is not the document's own.
 */
export function openerOf(items, to, title) {
  const norm = (n) => String(n ?? '').replace(/(?:\u2026|\.\.\.)\s*$/, '').trim().toLowerCase()
  const find = (...names) => (items ?? []).find((n) => names.includes(norm(n)))
  const [saveAs, dup, save] = [find('save as'), find('duplicate'), find('save')]
  const out = find('export', ...(ext(to) === 'pdf' ? ['export as pdf'] : []))
  return saveAs ? [saveAs] : dup && save ? [dup, save] : out && ext(to) !== ext(title) ? [out] : null
}

/**
 * An `open-panel` step: the File menu's items read (`menu(path)`: list-menu), the opener picked (`act(plan)`: a pick-menu), then a
 * fresh look (`lookIn(app)`) must show the panel, else it stops and nothing after it runs: no cmd+shift+g into the document. A panel
 * already in front is used as it is. After Duplicate, Save goes on only when a new window is in front (on the original it would
 * save over it in place). Each pick is a kept step (its `screen:step` row): run 251 T19's unkept pick left the fold not knowing this
 * task opened the panel, and leftModal refused the very next step as "this task did not open it".
 */
export async function openPanel(plan, { menu, act, lookIn, signal, pause = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const { app } = plan
  const stop = (why) => ({ refused: `refused: ${app} did not open a Save panel; the file was not saved (${why}). Nothing was typed. Look at ${app} and tell the owner.`, reason: 'no-save-panel' })
  const first = await lookIn(app)
  if (savePanel(first)) return { same: false, text: '', note: `${app} already shows its Save panel` }
  const file = (first?.menus ?? []).find((m) => /^file$/i.test(String(m).trim()))
  if (!file) return stop('its look lists no File menu')
  const items = await menu(file).catch(() => [])
  const order = openerOf(items, plan.given?.value, first?.window)
  if (!order) return stop(`its File menu lists no Save As, Duplicate and Save, or Export: ${items.slice(0, 20).map((n) => JSON.stringify(n)).join(', ') || 'nothing read'}`)
  const picked = []
  for (const item of order) {
    if (signal?.aborted) return { refused: 'refused: stopped: the owner stopped the turn, so the Save panel was not opened and nothing was saved.', reason: 'stopped' }
    const path = `${file} > ${item}`
    const r = await act({ ...plan, verb: 'pick-menu', line: `Pick "${path}" in ${app}`, thing: { role: 'menu item', name: path }, command: { target: { app, role: 'menu item', label: path }, action: 'pick-menu' } })
    if (r?.refused) return stop(`"${path}" was refused: ${String(r.refused).replace(/^refused: /, '')}`)
    picked.push(`"${path}"`)
    if (/^duplicate/i.test(item)) {
      const copy = (await lookIn(app))?.window
      if (!copy || copy === first?.window) return stop(`after "${path}" no new window was in front, so Save was not picked`)
    }
  }
  for (const ms of [0, 700]) {
    await pause(ms)
    if (savePanel(await lookIn(app))) return { same: false, text: '', note: `${app} shows its Save panel, opened by ${picked.join(' then ')}` }
  }
  return stop(`no Save panel showed after ${picked.join(' then ')}`)
}

const real = (path) => {
  try {
    return realpathSync(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
  } catch {
    return null
  }
}
const words = (e) => String(e?.label || e?.value || '').trim()
/** The sidebar places a walk may start from, as the folders they are: home (the short user name), its Desktop, Documents and Downloads, Applications, the start-up disk. */
const placeOf = (label) => (label === basename(homedir()) ? homedir() : ['Desktop', 'Documents', 'Downloads'].includes(label) ? join(homedir(), label) : label === 'Applications' ? '/Applications' : /^macintosh hd$/i.test(label) ? '/' : null)
/** A panel's parts in a look: its folder columns (`cells`), sidebar rows, name field, the folder its Where pop-up shows, and its "show more options" disclosure. */
function partsOf(look) {
  const all = look?.elements ?? []
  const fields = all.filter((e) => roleOf(e) === 'text field' && !/column view|side ?bar/i.test(String(e.in ?? '')) && !/tag/i.test(String(e.label ?? '')))
  return {
    cells: all.filter((e) => /^column view$/i.test(String(e.in ?? '').trim()) && roleOf(e) === 'text field' && words(e)),
    side: all.filter((e) => /\bside ?bar\b/i.test(String(e.in ?? '')) && /\brow\b/.test(roleOf(e)) && e.label),
    field: fields.find((e) => /^(?:save as|name|export as):?$/i.test(String(e.label ?? '').trim())) ?? fields[0],
    where: String(all.find((e) => roleOf(e) === 'pop up button' && /^where:?$/i.test(String(e.label ?? '').trim()))?.value ?? '').trim(),
    more: all.find((e) => /disclosure/.test(roleOf(e)) && /more options/i.test(String(e.label ?? ''))),
  }
}

/**
 * A `panel-go` step (S6, doc 30): the panel walked to the folder with no key, a fresh look before each move. It is there when the
 * Where pop-up shows the folder and the columns show it under its parent. Else a click on the deepest folder of the path the
 * columns show under its parent (or right under the sidebar place the walk began at); else a click on the sidebar place the path
 * lies under. Every click must go deeper. Doc 32 (run 261 T21): in the column browser a single click on a folder selected it and
 * opened nothing, where a double-click opened it; the model then walked it by hand in 29 calls. So a click that does not go deeper
 * is followed by a double-click on the same folder, and the rest of the walk double-clicks. A double-click that does not go deeper
 * either, a folder the panel never shows, or a panel that closes stops it with a line, and the Save after it does not run. Then the name by set-value, checked by a fresh look. Each move is an unkept act
 * (`act`), so no learned route clicks folder names.
 */
export async function panelGo(plan, { act, lookIn, signal }) {
  const { app, given = {} } = plan
  const { value: want, name } = given
  const stop = (why) => ({ refused: `refused: the ${app} panel did not get to ${JSON.stringify(want)}${name ? ', so the file was not saved' : ''} (${why}). No key was sent. Look at ${app} and tell the owner; its Where pop-up may list the folder.`, reason: 'panel-folder' })
  const dir = real(String(want ?? ''))
  if (!dir) return stop('there is no such folder on disk, and a save-as never makes one')
  const parts = dir.split('/').filter(Boolean)
  const base = parts.at(-1) ?? ''
  const moved = []
  // `look`: the newest look; `from`: the sidebar place the walk began at, and its depth in `parts`; `deepest`: the deepest folder clicked
  // since; `count`: 2 once a folder opened only on a double-click, and every folder after it is double-clicked.
  const at = { look: await lookIn(app), from: null, deepest: -1, count: 1 }
  const move = async (e, verb, value, count = 1) => {
    if (signal?.aborted) return { refused: 'refused: stopped: the owner stopped the turn, so the panel was left where it was and nothing was saved.', reason: 'stopped' }
    const line = `${verb === 'set-value' ? 'Name the file' : `${count > 1 ? 'Double-click' : `${verb[0].toUpperCase()}${verb.slice(1)}`} ${JSON.stringify(words(e))}`} in the ${app} panel`
    const r = await act({ ...plan, verb, line, thing: { role: roleOf(e), name: words(e) }, command: { look: at.look.id, ref: e.ref, action: verb === 'press' ? (actionFor(e, 'press') ?? 'click') : verb, ...(value === undefined ? {} : { value }), ...(count > 1 ? { count } : {}) }, unkept: true })
    if (!r?.refused) at.look = await lookIn(app)
    return r
  }
  const why = (r) => String(r.refused).replace(/^refused: /, '')
  for (let n = 0; ; n++) {
    if (!savePanel(at.look)) return stop(n ? 'the panel closed on the way' : 'no Save or Open panel is in front')
    const { cells, side, where, more } = partsOf(at.look)
    const x = (e) => Number(e.frame?.[0] ?? 0)
    const under = (j, c) => j === 0 || j === at.from?.depth || cells.some((p) => words(p) === parts[j - 1] && x(p) < x(c)) || !cells.some((p) => x(p) < x(c))
    if (where === base && (at.from?.at === dir || cells.length === 0 || cells.some((c) => words(c) === base && under(parts.length - 1, c)))) break
    if (n >= 16) return stop(`it was still not there after ${moved.length} clicks`)
    if (cells.length === 0 && more) {
      const r = await move(more, 'press')
      if (r?.refused) return stop(`its "show more options" press was refused: ${why(r)}`)
      continue
    }
    if (cells.length === 0) return stop('it shows no folder columns: its view is a list or icons')
    const shown = (j) => cells.find((c) => words(c) === parts[j] && under(j, c))
    const j = parts.findLastIndex((_, i) => shown(i))
    const cell = j < 0 ? null : shown(j)
    if (cell && j <= at.deepest && at.count > 1) return stop(`a double-click on "${parts[j]}" did not open it`)
    if (cell && j <= at.deepest) {
      const r = await move(cell, 'click', undefined, 2)
      if (r?.refused) return stop(`the double-click on "${parts[j]}" was refused: ${why(r)}`)
      moved.push(`${JSON.stringify(parts[j])} (a double-click)`)
      at.count = 2
      continue
    }
    const place = cell || at.from ? null : side.map((e) => ({ e, at: real(placeOf(String(e.label).trim()) ?? '') })).filter((p) => p.at && (p.at === '/' || dir === p.at || dir.startsWith(`${p.at}/`))).sort((a, b) => b.at.length - a.at.length)[0]
    if (!cell && !place) return stop(at.from ? `no folder of its path showed after a click on ${moved.at(-1)}` : 'no folder of its path shows in its columns, and its sidebar holds no place the path lies under')
    const r = await move(cell ?? place.e, 'click', undefined, cell ? at.count : 1)
    if (r?.refused) return stop(`the click on "${words(cell ?? place.e)}" was refused: ${why(r)}`)
    moved.push(`${JSON.stringify(words(cell ?? place.e))}${cell && at.count > 1 ? ' (a double-click)' : ''}`)
    if (cell) at.deepest = j
    else Object.assign(at, { from: { at: place.at, depth: place.at.split('/').filter(Boolean).length }, deepest: -1 })
  }
  if (name && String(partsOf(at.look).field?.value ?? '') !== name) {
    const { field } = partsOf(at.look)
    if (!field) return stop('it shows no name field')
    const r = await move(field, 'set-value', name)
    if (r?.refused) return stop(`the name was refused: ${why(r)}`)
    const now = partsOf(at.look)
    if (!savePanel(at.look) || now.where !== base || String(now.field?.value ?? '') !== name) return stop(`after the name, its Where pop-up shows ${JSON.stringify(now.where)} and its name field ${JSON.stringify(String(now.field?.value ?? ''))}`)
  }
  return { same: false, text: '', note: `The ${app} panel shows ${JSON.stringify(base)}${moved.length ? `, after a click on ${moved.join(', then ')}` : ' already'}${name ? `, the name ${JSON.stringify(name)} set` : ''}` }
}
