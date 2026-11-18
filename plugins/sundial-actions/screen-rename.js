// Finder's inline rename as one step of screen_act (Set 3 Round 2): {app: "Finder", action: "rename", ref, value: "Juniper.txt"}.
//
// Runs 183 to 190, the correct family: the rename never completed (two timeouts in four). In list view a file's name is a
// text field that is always there, so the model clicked it, pressed cmd+a (which selects every file), typed (which only
// jumps the selection) and pressed Return (which opens the real editor, and nothing went in it). After Return the
// look that follows read Finder's desktop window, not the folder (run 190: no focus, no field, five times), so the model
// never saw the editor it had opened and looped on row, Return, look.
//
// Run 198 (the frames, icon view and list view alike): Return opened the rename box with the name selected up to its
// extension, and no look ever listed the box (a list's walk takes its visible items, and the box is none of them: the
// look's focus named no part). So the step always took its fallback, cmd+a, which is Finder's Edit > Select All: it closed
// the box at once, the typed name went to the file list as type-select, and the last Return opened a fresh empty box.
//
// The step: a click on the row selects the file; Return opens the box; a look of the folder's own window by its title
// checks the keyboard left the file list (still on a listed part that is no text field, or a field without the name: the
// box did not open, nothing is typed). The look lists the box as its focused part (ScreenLook.swift focusedPart, after
// run 198): its value is set to the new name (the base alone when the box shows no extension and the extension stays).
// A look that lists no focused part (an older app build) falls back to typing, no cmd+a: the base name alone when the
// extension stays (the box holds it unselected), else shift+cmd+right first so the whole name is replaced. Return commits; a look of the folder proves it by
// the files listed (never the sidebar, never the window title). Anything short of that presses escape and says what to do.
//
// Named exports only.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { prune, roleOf } from './screen-look.js'
import { rowsUntil } from './screen-proof.js'

// The part's centre inside the row's frame, both ways: the sidebar's row on the same line holds its y, never its x (runs 191,
// 193: the rename clicked "Shared" and Finder left the folder).
const inside = (f, r, i) => Array.isArray(f) && Array.isArray(r) && f[i] + f[i + 2] / 2 >= r[i] && f[i] + f[i + 2] / 2 <= r[i] + r[i + 2]
const within = (f, row) => inside(f, row?.frame, 0) && inside(f, row?.frame, 1)
const isField = (e) => /text field/.test(roleOf(e))
const bare = (name) => String(name).replace(/\.[^.\s]{1,8}$/, '')

/** A file in a Finder look by any of its parts: `{ name, select }`, its name and the thing a click selects it by (the row, else the part). */
export function fileIn(look, ref) {
  const all = look?.elements ?? []
  const e = all.find((x) => x.ref === ref)
  if (!e) return null
  if (isField(e) && e.value) return { name: e.value, select: all.find((x) => /\brow\b/.test(roleOf(x)) && within(e.frame, x)) ?? e }
  if (/\brow\b/.test(roleOf(e))) {
    const field = all.find((x) => isField(x) && x.value && within(x.frame, e))
    return field ? { name: field.value, select: e } : null
  }
  return /image|cell/.test(roleOf(e)) && e.label ? { name: e.label, select: e } : null
}

/** A file in a Finder look by its name: the ref of its name field (list view) or its icon (icon view), or null. */
export const fileNamed = (look, name) => (look?.elements ?? []).find((e) => (isField(e) ? e.value : /image/.test(roleOf(e)) ? e.label : null) === name)?.ref ?? null

/** The rename step's plan from the look the file is in, or `{ error }`. */
export function renamePlan(look, ref, to, app = 'Finder') {
  const name = String(to ?? '').trim()
  if (!/^finder$/i.test(String(app ?? ''))) return { error: 'invalid arguments: rename is a Finder step: {app: "Finder", action: "rename", ref: <the file\'s name or row>, value: "<the new name with its extension>"}' }
  if (!name || /[/:]/.test(name) || name.length > 255) return { error: 'invalid arguments: rename needs value, the new file name with its extension ("Juniper.txt"), no / or :' }
  const file = look ? fileIn(look, ref) : null
  if (!file) return { error: `invalid arguments: ${ref ?? 'that'} is no file in Finder's last look: give the ref of the file's name, row or icon from screen_look {app: "Finder"}` }
  if (file.name === name) return { error: `invalid arguments: the file is already named ${JSON.stringify(name)}` }
  const because = `rename ${JSON.stringify(file.name)} to ${JSON.stringify(name)} in Finder`
  return { verb: 'rename', app: look.app || 'Finder', thing: { role: 'file', name: file.name }, rename: { old: file.name, to: name, window: look.window, select: { look: look.id, ref: file.select.ref, action: 'click' } }, because, line: `R${because.slice(1)}`, command: {} }
}

/**
 * The model's own chain for it, as one rename: a click (press, select, focus) on a Finder file, then optionally Return (or
 * the menu's Rename) and cmd+a, then a type, then optionally Return. `lookOfId(id)` reads the look the click named. Plans come back unchanged otherwise.
 */
export async function asRename(plans, lookOfId) {
  const key = (p, re) => p?.verb === 'key' && re.test(String(p.command?.value ?? '').replace(/\s/g, ''))
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]
    if (!/^finder$/i.test(String(p.app)) || !p.command?.ref || !p.command.look) continue
    // Run 206 T19: a type straight into a file's name field in list view, no click first, only type-selected and reported a
    // change; the Return after it opened an empty box. A field inside a file's row only, never the search field.
    if (['type', 'set-value'].includes(p.verb) && typeof p.command.value === 'string') {
      const look = await lookOfId(p.command.look)
      const file = look ? fileIn(look, p.command.ref) : null
      const one = file && file.select.ref !== p.command.ref ? renamePlan(look, p.command.ref, p.command.value, p.app) : null
      if (!one || one.error) continue
      plans = [...plans.slice(0, i), { ...one, given: p.given }, ...plans.slice(key(plans[i + 1], /^(return|enter)$/i) ? i + 2 : i + 1)]
      continue
    }
    if (!['click', 'press', 'select', 'focus'].includes(p.verb)) continue
    let j = i + 1
    if (key(plans[j], /^(return|enter)$/i) || (plans[j]?.verb === 'pick-menu' && /(^|>)\s*rename\b/i.test(String(plans[j].thing?.name ?? '')))) j++
    if (key(plans[j], /^(cmd|command|meta)\+a$/i)) j++
    if (plans[j]?.verb !== 'type' || typeof plans[j].command?.value !== 'string') continue
    const to = plans[j].command.value
    if (key(plans[j + 1], /^(return|enter)$/i)) j++
    const one = renamePlan(await lookOfId(p.command.look), p.command.ref, to, p.app)
    if (one.error) continue
    plans = [...plans.slice(0, i), { ...one, given: p.given }, ...plans.slice(j + 1)]
  }
  return plans
}

/**
 * Runs the rename: `perform(plan, because, goal, session, more)` is screen_act's own step, `lookIn(app, window)` a look of
 * that window (null on none), `appendSignal` writes the one step a route keeps. Answers as a step does: `{ refused, reason }` or `{ text }`.
 */
export async function renameIn(plan, { perform, lookIn, appendSignal, signal }, because, goal, session) {
  const { old, to, window, select } = plan.rename
  const sub = (verb, name, command) => perform({ ...plan, verb, thing: { role: verb === 'click' ? 'row' : verb === 'set-value' ? 'text field' : undefined, name }, command, unkept: true }, because, goal, session, true)
  const key = (value) => sub('key', value, { target: { app: plan.app }, action: 'key', value })
  const names = (look) => new Set(prune(look?.elements).filter((e) => !/sidebar/i.test(e.in ?? '')).flatMap((e) => (isField(e) ? [e.value] : /image/.test(roleOf(e)) ? [e.label] : [])).filter(Boolean))
  // Run 198: after a failed rename the model rebuilt it from clicks, cmd+a, set-value and File > Rename for three minutes.
  const next = `Next: send this same step once more, {app: "Finder", action: "rename", label: ${JSON.stringify(old)}, value: ${JSON.stringify(to)}}; if it fails again, stop and tell the owner the file could not be renamed. Never rebuild it from clicks, Return, cmd+a, typing, set-value or File > Rename (cmd+a closes Finder's rename box), and never the shell.`
  const kept = (ok, more) => appendSignal('screen:step', { id: `act-rename-${Date.now().toString(36)}`, processName: plan.app, verb: 'rename', role: 'file', screenText: [old], typed: to.length, ...(goal ? { goal } : {}), ...(window ? { windowTitle: window } : {}), ...(session ? { session: String(session) } : {}), ok, ...more }).catch(() => {})
  const acts = []
  const done = async () => (await kept(true, { changed: true }), { same: false, window, text: `Renamed ${JSON.stringify(old)} to ${JSON.stringify(to)} in Finder: the folder now lists ${JSON.stringify(to)} and no ${JSON.stringify(old)}.` })
  const listed = (after) => (after.has(to) || after.has(bare(to))) && !after.has(old)
  // A Stop before the first act leaves nothing open: no Escape then. Run 219 T18: the Stop came after the new name was set,
  // Finder kept it through the Escape, and the answer said two renamed with three on disk. Stopped once the name went in,
  // the folder is read again (a look, no act): the name it lists is the answer.
  const fail = async (r) => {
    if (r.reason !== 'stopped' || acts.length > 0) await key('escape').catch(() => null)
    if (r.reason === 'stopped' && acts.length > 2 && listed(names(await lookIn(plan.app, window)))) return done()
    await kept(false, { reason: r.reason })
    return r
  }
  // The steps in order; the first refusal stops the rename and is its answer. Run 215 T18: the owner's Stop came between the
  // click and the Return, the rest ran after it and the name went in. A Stop (the call's abort signal) ends it before the next act.
  const run = async (...steps) => {
    for (const step of steps) {
      if (signal?.aborted) return { refused: `refused: stopped: the owner stopped the turn, so ${JSON.stringify(old)} was not renamed.${acts.length ? ' Escape was pressed to close the rename box.' : ''}`, reason: 'stopped' }
      acts.push(step)
      const r = await step()
      if (r?.refused) return r
    }
    return null
  }
  const opened = await run(() => sub('click', old, select), () => key('return'))
  if (opened) return fail(opened)
  // Its own look of the folder's window by its title (run 190: the look after Return read the desktop window): the keyboard
  // still on a listed part that is no text field (the file list) means Return opened no box, and nothing is typed.
  const seen = await lookIn(plan.app, window)
  const at = (seen?.elements ?? []).find((e) => e.ref === seen?.focused)
  if (at && !(isField(at) && [old, bare(old)].includes(at.value))) return fail({ refused: `refused: no-rename-box: Return did not open Finder's rename box on ${JSON.stringify(old)} (the keyboard stayed in the file list, or in a field without its name), so nothing was typed. Escape was pressed. ${next}`, reason: 'no-rename-box' })
  // The box selects the name up to its extension: the base alone keeps it; another extension selects to the end first.
  const ext = (n) => n.slice(bare(n).length).toLowerCase()
  const keep = ext(old) !== '' && ext(old) === ext(to)
  const text = keep ? bare(to) : to
  const type = () => sub('type', to, { target: { app: plan.app }, action: 'type', value: text })
  // The box as the look lists it: its whole value is set, so what it had selected does not matter.
  const set = () => sub('set-value', old, { look: seen.id, ref: at.ref, action: 'set-value', value: at.value === old ? to : text })
  const typed = await run(...(at ? [set] : [...(ext(old) && !keep ? [() => key('shift+cmd+right')] : []), type]), () => key('return'))
  if (typed) return fail(typed)
  const after = names(await lookIn(plan.app, window))
  if (!listed(after)) return fail({ refused: `refused: rename-not-seen: after the rename the folder lists ${[...after].slice(0, 12).map((n) => JSON.stringify(n)).join(', ') || 'no file'}, so ${JSON.stringify(old)} was not renamed to ${JSON.stringify(to)}. Escape was pressed to close any rename box left open. ${next}`, reason: 'rename-not-seen' })
  return done()
}

/**
 * S5R2 (plan 3.5): the renames a call made (`{ old, to }`), proven by the log: the file watcher's row adds the new name, and
 * then on disk the new name exists and the old one does not. A rename with no row says so; the folder's look is then the only
 * proof. `files(from, to)` reads the log's `file:changed` rows; '' with no reader or no rename.
 */
export async function renameProof(renames, { files, since, ms, wait, exists = existsSync }) {
  if (!files || renames.length === 0) return ''
  const added = (changes, to) => changes.findLast((c) => c.kind !== 'delete' && basename(c.path) === to)
  const found = await rowsUntil(files, since, (changes, last) => (last || renames.every(({ to }) => added(changes, to)) ? changes : null), { ms, wait })
  const disk = (path) => exists(path.replace(/^~(?=\/)/, homedir()))
  return renames.map(({ old, to }) => {
    const row = found && added(found, to)
    if (!row) return `\nRename check: no file row for ${JSON.stringify(to)} in the log (a folder outside the watched projects writes none): the folder's look is the only proof.`
    const was = `${dirname(row.path)}/${old}`
    return disk(row.path) && !disk(was) ? `\nRename check: the log's file row shows ${JSON.stringify(row.path)} added; on disk it exists and ${JSON.stringify(old)} does not.` : `\nRename check: the log shows ${JSON.stringify(row.path)} added, but on disk ${disk(row.path) ? `${JSON.stringify(old)} still exists too` : 'it does not exist'}: look at the folder before you say it is renamed.`
  }).join('')
}
