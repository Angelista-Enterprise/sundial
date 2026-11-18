// Run 206 T17: a press on a page whose title said loading came back not-found, then the model waited and pressed again.
// Before each step, screen_act waits for a window that says loading to lose the word, as gnomon_await `gone` does.
// Named exports only.
import { stepList } from './gate.js'

/** A title that says the page or window is not ready yet (await-tool.js has the same). */
export const LOADING = /\bloading\b/i

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The app of this call whose window says loading (the fold's front window, else the app's last look) and that title, or null. */
export function loadingOf(state, args) {
  const named = String(args?.app ?? stepList(args?.steps)?.find((s) => s?.app)?.app ?? '').trim().toLowerCase()
  const seen = [[state?.window?.active?.processName, state?.window?.active?.windowTitle], [state?.marks?.lastLook?.app, state?.marks?.lastLook?.window]]
  const hit = seen.find(([a, t]) => a && (!named || String(a).toLowerCase() === named) && LOADING.test(String(t ?? '')))
  return hit ? { app: hit[0], title: String(hit[1]) } : null
}

/** One screen_act call waits this long at most for loading windows, over all its steps (Fable review M3). */
export const CALL_WAIT_MS = 20_000

/**
 * Reads `title(app)` until it no longer says loading, `waitMs` at most, or until `stop()` (the turn's Stop, the owner's
 * correction): `{ ms, ok, stopped? }`, ok when the word left the title.
 */
export async function waitLoaded(app, { title, waitMs = 15_000, pollMs = 700, stop = () => false }) {
  const started = Date.now()
  const read = { title: '', stopped: false }
  for (;;) {
    if ((read.stopped = stop())) break
    read.title = (await title(app).catch(() => null)) ?? read.title
    if ((read.title && !LOADING.test(read.title)) || Date.now() - started >= waitMs || (read.stopped = stop())) break
    await sleep(pollMs)
  }
  return { ms: Date.now() - started, ok: Boolean(read.title) && !LOADING.test(read.title), ...(read.stopped ? { stopped: true } : {}) }
}

/**
 * Before each of screen_act's steps (Set 4 R1: every step, so a url, raise or press that brought up a loading window is
 * waited for too): the wait, when this step's app says loading, and its `screen:waited` row. `done` is the title a wait of
 * this call already outlasted: the fold may still show it, or the page may be loading again after a click, so one title read
 * decides (Fable review M4). `budget.ms` is what is left of the call's wait (CALL_WAIT_MS, one object per call). The turn's
 * `signal` (the owner's Stop) or `stop()` (their correction) ends a wait at once (Fable review M3); after a Stop nothing acts.
 * Returns the title waited on, else `done`.
 */
export async function loaded(args, { getState, appendSignal, budget = { ms: CALL_WAIT_MS }, signal, stop = () => false, ...load }, goal, session, done = null) {
  const hit = loadingOf(getState(), args)
  const halt = () => signal?.aborted === true || stop()
  if (!hit || budget.ms <= 0 || halt()) return done
  if (hit.title === done && !LOADING.test((await load.title(hit.app).catch(() => null)) ?? '')) return done
  const { ms, ok, stopped } = await waitLoaded(hit.app, { ...load, waitMs: Math.min(load.waitMs ?? 15_000, budget.ms), stop: halt })
  budget.ms -= ms
  await appendSignal('screen:waited', { processName: hit.app, gone: 'loading', ms, ok, ...(stopped ? { stopped } : {}), ...(goal ? { goal } : {}), ...(session ? { session: String(session) } : {}) }).catch(() => {})
  if (signal?.aborted) throw new Error('The owner stopped this before it acted: nothing was done.')
  return hit.title
}
