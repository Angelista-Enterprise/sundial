// S5R2 (plan 3.5): a result proven by the log. After a save or a Save As by screen, the disk (review S5R2 M4) and the file
// watcher's `file:changed` row say where the file landed; with neither, the step says no file change was seen, and nothing may
// call it saved. Run 224 saved a copy into the folder of run 215 (the Save panel remembered it), and Gnomon found out only by a shell `ls`.
//
// The wait is doc 19's: it ends on the fold's change event (`wait`, the same one gnomon_await and every act wait on), and the
// log is read again then, for a few seconds at most (the watcher writes its row about 2 s after the write).
//
// Named exports only.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { defaultFinal } from './default-final.js'
import { BROWSERS, oneOf } from './gate-finals.js'

/** How long a save is waited for: the watcher's 2 s debounce, and its write. */
export const PROOF_MS = 4000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const KEYS = { command: 'cmd', meta: 'cmd', '⌘': 'cmd', option: 'alt', opt: 'alt' }
const keyOf = (v) => {
  const parts = String(v ?? '').toLowerCase().replace(/\s/g, '').split('+').map((k) => KEYS[k] ?? k)
  return [...parts.slice(0, -1).sort(), parts.at(-1)].join('+')
}
const isKey = (p, ...keys) => p?.verb === 'key' && keys.includes(keyOf(p.command?.value))
const SAVE = /^\s*(?:save|export)\b/i
/** An item or a button that only opens a sheet (Save As…, Export…). */
const MORE = /(?:…|\.\.\.)\s*$/
const nameOf = (p) => (['pick-menu', 'press', 'click'].includes(p?.verb) ? String(p.thing?.name ?? '').split('>').at(-1).trim() : '')
/** A step that writes the file: cmd+s, a Save or Export item (a native button too: a web page's Save is no file), or Return on a sheet whose default button is Save. */
const writes = (p, look) => isKey(p, 'cmd+s') || (SAVE.test(nameOf(p)) && !MORE.test(nameOf(p)) && (p.verb === 'pick-menu' || !oneOf(BROWSERS, p.app))) || (isKey(p, 'return', 'enter') && look?.app === p.app && SAVE.test(String(defaultFinal(look)?.label ?? '')))
/** A step that opens a Save or Export sheet: the file is written by a Return or a Save after it. */
const opens = (p) => isKey(p, 'cmd+shift+s', 'alt+cmd+shift+s') || (SAVE.test(nameOf(p)) && MORE.test(nameOf(p)))

/** Whether the steps that ran write a file. `look()`: the app's look as the call began, read only for a Return (a sheet's Save). */
export async function saves(plans, look = async () => null) {
  const seen = plans.some((p) => isKey(p, 'return', 'enter')) ? await look() : null
  return plans.some((p, i) => writes(p, seen) || (opens(p) && plans.slice(i + 1).some((q) => isKey(q, 'return', 'enter') || SAVE.test(nameOf(q)))))
}

/** The changes of `file:changed` rows, each with its whole path as the record writes it (under ~/ for the home folder). */
export const changesOf = (rows) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const d = row?.data ?? row ?? {}
    return (Array.isArray(d.changes) ? d.changes : []).filter((c) => typeof c?.relPath === 'string').map((c) => ({ path: `${String(d.projectRoot ?? '').replace(/\/$/, '')}/${c.relPath}`, kind: String(c.kind ?? 'modify') }))
  })

/** Reads the log's file rows since `since` until `found(changes, last)` gives something, or `ms` pass (`last`: the final read): what it gave, else null. */
export async function rowsUntil(files, since, found, { ms = PROOF_MS, wait } = {}) {
  for (const end = Date.now() + ms; ; ) {
    const last = Date.now() >= end
    const hit = found(changesOf(await files(new Date(since - 1000).toISOString(), new Date(Date.now() + 1000).toISOString()).catch(() => [])), last)
    if (hit || last) return hit ?? null
    await Promise.all([wait ? wait(end - Date.now()) : null, sleep(Math.max(0, Math.min(250, end - Date.now())))])
  }
}

const quote = (s) => JSON.stringify(String(s))
const bare = (name) => name.replace(/\.[^.\s]{1,8}$/, '')
const home = (path) => String(path).replace(/^~(?=\/)/, homedir())
/** Whether the file at `path` was written at or after `since` (ms), read off the disk. */
const written = (path, since) => { try { return statSync(home(path)).mtimeMs >= since } catch { return false } }
/**
 * The line a save's step result ends with, or '' when no step of `plans` writes a file (or there is no log reader). `state()`:
 * the fold, whose front window names the document (`documentPath`, its title).
 * Review S5R2 M4: with the document's whole path, the disk is the proof (its mtime since this call; a folder outside the
 * watched projects writes no row, and the row's path is under ~/ where AX gives an absolute one), and a file row of that same
 * path a second witness. With no path, a row of a file named as the window is "a file by that name", never where it landed.
 * S5R2 (plan 2B): a save-as step (screen-save.js) names the whole path (`saveTo` on its Save step): the disk at that path is the
 * proof that it landed in the named folder; another file written since (the window's, or a row of the same name) is said as elsewhere.
 */
export async function saveProof(plans, { files, since, state, look, ms = PROOF_MS, wait }) {
  if (!files || !(await saves(plans, look))) return ''
  const app = String(plans.findLast((p) => p.app)?.app ?? '').toLowerCase()
  const to = plans.findLast((p) => typeof p?.given?.saveTo === 'string')?.given.saveTo
  const doc = () => {
    const w = state()?.window?.active
    if (!w || String(w.processName ?? '').toLowerCase() !== app) return { names: [] }
    // AX gives a file:// URI with its escapes (%20); the watcher's path has the plain name.
    const raw = String(w.documentPath ?? '').replace(/^file:\/\/(?:localhost)?/, '')
    const path = raw ? (() => { try { return decodeURI(raw) } catch { return raw } })() : null
    return { path, names: [path && basename(path), String(w.windowTitle ?? '').replace(/\s+[\u2014-]\s+Edited$/, '').trim()].filter(Boolean) }
  }
  const hit = await rowsUntil(files, since, (changes, last) => {
    const { path, names } = doc()
    const kept = changes.filter((c) => c.kind !== 'delete')
    if (to) {
      if (written(to, since)) return { path: to, row: kept.some((c) => home(c.path) === home(to)), named: true }
      const other = path && home(path) !== home(to) && written(path, since) ? path : kept.findLast((c) => basename(c.path) === basename(to))?.path
      return other && last ? { path: other, elsewhere: true } : null
    }
    if (path) return written(path, since) ? { path, row: kept.some((c) => home(c.path) === home(path)) } : null
    const named = kept.filter((c) => names.some((n) => [basename(c.path), bare(basename(c.path))].includes(n))).at(-1)
    return named ? { path: named.path, byName: true } : null
  }, { ms, wait })
  if (hit?.named) return `\nSave check: on disk ${quote(to)} was written since this call${hit.row ? ", and the log's file row shows it too" : ''}: it landed in the named folder ${quote(dirname(to))}.`
  if (hit?.elsewhere) return `\nSave check: it did NOT land in the named folder ${quote(dirname(to))}: nothing was written at ${quote(to)}, and ${quote(hit.path)} was written since this call. Say plainly that it landed there, not in the folder asked for.`
  if (hit?.byName) return `\nSave check: the window gives no path; the log's file row shows a file by that name written since this call, ${quote(hit.path)}. Look at the window before you say where it landed.`
  if (hit) return `\nSave check: on disk ${quote(hit.path)} was written since this call${hit.row ? ", and the log's file row shows it too" : ''}: that is where it landed.`
  const { path, names } = doc()
  const of = to ? ` for ${quote(to)}` : path ? ` for ${quote(path)}` : names.length ? ` for ${names.map(quote).join(' or ')}` : ''
  return `\nSave check: no file change was seen on disk or in the log in ${ms / 1000} s${of}. Do not say it is saved: look at the window or the folder first.`
}
