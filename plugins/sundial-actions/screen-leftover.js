// S5R3 (doc 29, runs 248 and 249): a sheet another app holds that this chat did not open. Gnomon's own look listed TextEdit's
// "Save" and "draft.txt", and the answer said nothing of it: the brief's "Left open by someone else" (helpers `leftOpen`) reaches
// the model only on the next turn. So the screen tool's own answer says it, in the task that saw it: once per chat, task and app,
// never for a private app, and never as a step to take.
//
// Named exports only.
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js'
import { leftOpen, plainTitle, sameSheet } from '@sundial/helpers/opened.js'
import { taskOf } from '@sundial/helpers/task-of.js'
import { privateApp } from './gate-finals.js'

/** A Save, Open, Export or Print panel, by the title the window list gives it. */
const PANEL = /^(?:save|save as|open|export|export as|print|choose|import)(?:\s*(?:…|\.\.\.))?$/i
const overlaps = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/**
 * The panels a look's window list shows in apps other than the one it read, each with the document window it sits on when one is
 * under it: the list runs front to back and a sheet is drawn just above its window, so the first of the app's windows after it that
 * it overlaps (doc 30, run 252: three Save sheets in TextEdit, each overlapping every window).
 */
export function sheetsIn(look) {
  const windows = Array.isArray(look?.screen?.windows) ? look.screen.windows : []
  const panel = (w) => PANEL.test(String(w?.windowTitle ?? '').trim())
  return windows.flatMap((w, at) => {
    const app = typeof w?.processName === 'string' ? w.processName : ''
    if (!app || app === look.app || !panel(w)) return []
    const doc = windows.slice(at + 1).find((d) => d?.processName === app && typeof d.windowTitle === 'string' && d.windowTitle.trim() !== '' && !panel(d) && overlaps(d.frame, w.frame))
    return [{ app, ...(doc ? { window: plainTitle(doc.windowTitle) } : {}) }]
  })
}

/** The line for one leftover sheet. */
const lineOf = ({ app, window, earlier }) => `${app} has a sheet you ${earlier ? 'left open in an earlier task' : 'did not open'}${window ? ` in front of ${JSON.stringify(window.slice(0, 60))}` : ''}. Leave it alone and mention it in your answer.`

/**
 * Doc 30 (run 250): the lines a chat's answers said since `since` (ms), from the fold (`state.opened.said`). A chain of steps answers
 * with its last step's text only, so the line its first step's after-look said was lost and the last step's found it said: a route
 * replay adds the lines said while it ran (screen-pick.js `replayed`).
 */
export const saidSince = (state, session, since) => (state?.opened?.said?.[String(session ?? '')] ?? []).filter((s) => Date.parse(s.at) >= since).map(lineOf)

/**
 * `(look, session, now?)`: the line a screen tool's answer ends with, a line break first, or ''. The sheets come from the look's
 * window list and from the fold (`leftOpen`: the sensor's and earlier looks' sightings), in apps other than the one looked at. A sheet
 * this chat opened, by app and window (`sameSheet`), is not said in the task that opened it; one an earlier task left is said as
 * that. Each app once per chat and task (a chat with no task: once), a sheet this chat did not open first. What is said goes on the
 * record (`screen:leftover-said`, folded into `state.opened.said`): the once-per-task rule reads the fold, so it holds after a restart.
 */
export function leftovers(getState, appendSignal = async () => {}) {
  return (look, session, now = Date.now()) => {
    const state = getState()
    const chat = String(session ?? '')
    const task = taskOf(state, chat)?.id ?? ''
    const mine = state?.opened?.chats?.[chat]?.items ?? []
    const found = [...sheetsIn(look), ...leftOpen(state, chat, now).filter((l) => l.app !== look?.app)]
    const apps = new Map()
    for (const { app, window } of found) {
      if (privateApp(app) || isRedactedPlaceholder(app) || (window && isRedactedPlaceholder(window))) continue
      const own = mine.findLast((i) => sameSheet(i, app, window))
      if (own && (own.task ?? '') === task) continue
      const was = apps.get(app)
      if (!was || (was.earlier && !own) || (Boolean(was.earlier) === Boolean(own) && !was.window && window)) apps.set(app, { app, window, earlier: Boolean(own) })
    }
    const said = state?.opened?.said?.[chat] ?? []
    const fresh = [...apps.values()].filter(({ app }) => !said.some((s) => s.app === app && (s.task ?? '') === task))
    // The row folds before any later step's answer is read (the runtime appends in order), so a chain's next look finds it said.
    for (const { app, window, earlier } of fresh) Promise.resolve(appendSignal('screen:leftover-said', { session: chat, app, ...(window ? { window } : {}), ...(earlier ? { earlier: true } : {}), ...(task ? { task } : {}) })).catch(() => {})
    return fresh.length ? `\n${fresh.map(lineOf).join('\n')}` : ''
  }
}
