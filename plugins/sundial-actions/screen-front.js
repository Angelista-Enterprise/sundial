// What is in front, for screen_look: the file its window has open, and SET4 R2's hand-off, the newest look kept.
// Named exports only.
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js'
import { frontLook } from '@sundial/helpers/last-look.js'
import { privateApp } from './gate.js'

/** Run 103 T06: the model ran find over $HOME for the file the front window had open. That file, when the look is of it. */
export function docOf(state, look) {
  const active = state?.window?.active
  const path = active?.processName === look.app && active.windowTitle === look.window && look.front !== false && !privateApp(look.app) ? active.documentPath : null
  return typeof path === 'string' && path !== '' && !isRedactedPlaceholder(path) ? path : undefined
}

/**
 * SET4 R2: a screen_look answered from the newest look of this chat's task in flight (`session`), with no new look (@sundial/helpers last-look.ts:
 * its app and window still in front, no act, key or click since). Only when the call names that app (or none) and a part of
 * that window (or none), asks for no text in pictures and no menu, and the app is not private. `staged(app)`: the screen
 * stage, when on, already holds the app (a look is what places it).
 */
export function keptLook(state, args, { now = Date.now(), handAt = null, staged = () => true, session } = {}) {
  if (args?.ocr === true || (typeof args?.menu === 'string' && args.menu.trim() !== '')) return null
  const look = frontLook(state, now, { handAt, task: true, session })
  if (!look || !staged(look.app) || [look.app, look.window ?? ''].some((s) => privateApp(s) || isRedactedPlaceholder(s))) return null
  const [app, window] = ['app', 'window'].map((k) => (typeof args?.[k] === 'string' ? args[k].trim().toLowerCase() : ''))
  return (!app || app === look.app.toLowerCase()) && (!window || (look.window ?? '').toLowerCase().includes(window)) ? look : null
}

/**
 * Doc 31 (run 254 T19): a double-click on a file in Finder opened it in TextEdit, which was not running. The act said "nothing on
 * screen changed" (it compares Finder only), the look at TextEdit 2 s later said no-window (it was still starting), and Gnomon gave
 * up 5 s later; the file was open 27 s in. An act that opens a document: a double-click on a file (in Finder, or a name with an
 * extension), or Finder's cmd+o or cmd+down.
 */
export const opensDoc = (plan, seen) => {
  const finder = /^finder$/i.test(String(plan?.app ?? '').trim())
  const file = finder || /\.[a-z0-9]{1,8}$/i.test(String(plan?.thing?.name ?? '').trim())
  const opens = (plan?.verb === 'click' && Number(plan.command?.count) >= 2 && file) || (finder && plan?.verb === 'key' && /^(?:cmd|command)\+(?:o|down)$/i.test(String(plan.command?.value ?? '').replace(/\s/g, '')))
  // Doc 32 (run 258 T19): the double-click on notes.txt moved a scroll bar in Finder, so "something changed" and no wait ran. The wait
  // runs whatever the app's own look shows, unless the app went to a new window of its own (a folder opened in Finder itself).
  return Boolean(opens) && !(seen?.now && seen.was && seen.now.window !== seen.was.window)
}

/**
 * After such an act: the front app looked at (`lookFront`, a look with no app) every `every` ms up to `ms`, until another app is in
 * front with a window, the file's name in its title. `{ same, text }` for the act's answer, `text` its own after `said`: what came to
 * the front and its look (`format`), or that the app may still be starting. With nothing else in front, no `same`: the act's own stays.
 * Doc 32 (run 258 T19): a front look refused "no-window" was dropped, and the wait said "no other app came to the front" while
 * TextEdit was in front. Such a refusal names the app in front: it is "not yet", the polling goes on, and the answer names that app.
 */
export async function openedIn(plan, said, lookFront, format, { ms = 10_000, every = 1_000, sleep = (n) => new Promise((r) => setTimeout(r, n)) } = {}) {
  // A thing with no words of its own is named by its ref (e5): no file name to wait for.
  const stem = String(plan.thing?.name ?? '').trim().replace(/^e\d+(?:@\w+)?$/, '').replace(/\.[^.]*$/, '').toLowerCase()
  const named = (look) => !stem || look.window.toLowerCase().includes(stem)
  const seen = { other: null, starting: null }
  for (const until = Date.now() + ms; ; await sleep(every)) {
    const look = await Promise.resolve(lookFront()).catch(() => null)
    const another = Boolean(look?.app) && look.app.toLowerCase() !== String(plan.app).toLowerCase()
    if (another && !look.refused && look.window) seen.other = look
    else if (another && /^(?:no-window|not-responding)$/.test(String(look.refused ?? ''))) seen.starting = look.app
    if ((seen.other && named(seen.other)) || Date.now() + every > until) break
  }
  const { other, starting } = seen
  if (other) return { same: false, text: `${said}\n${other.app} came to the front with its window ${JSON.stringify(other.window)}: the step opened it there${named(other) ? '' : ', though that title does not name the file yet (it may still be opening: look again in a few seconds)'}.\n${format(other, { budget: 12 })}` }
  if (starting) return { same: false, text: `${said}\n${starting} came to the front: the step opened it there, but in ${Math.round(ms / 1000)} s it gave no window a look can read yet (it may still be starting: a first start can take 20 s). Wait a few seconds (gnomon_await) and look at ${starting} again before you say the file did not open; a "no-window" now is that start, not a failure.` }
  return { text: `${said}\nNo other app came to the front in ${Math.round(ms / 1000)} s. If it opens the file in an app that was not running, that app may still be starting (a first start can take 20 s): wait a few seconds (gnomon_await) and look at that app again before you say the file did not open; a "no-window" right after is that start, not a failure.` }
}

/** The line a kept look's answer starts with. */
export const keptLine = (look, now = Date.now()) => `Your look of ${look.app} from ${Math.max(0, Math.round((now - Date.parse(look.at)) / 1000))} s ago: its window is still in front and nothing was done in it since, so no new look was taken (ocr: true takes one).\n`
