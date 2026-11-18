// Wait for the world to change, instead of guessing how long it takes.
//
// Measured over runs 13 and 14: 48% of the whole clock went on `sleep` inside shell commands — 241
// seconds of two runs that took 500. The model guessed 39 seconds for a job that took 24, and 38 for an
// app that appeared after 30, then hunted the screen for what the log had recorded 0.3 s after it
// happened. Nothing was wrong with the guessing; there was simply no way to wait for a fact.
//
// Everything this waits on is already folded:
//   - a background shell job      → `state.jobs[id]`, from `shell:exited` (rules/shell-jobs.ts)
//   - an app coming to the front  → `state.window.active.processName` (rules/window-track.ts)
//   - a window title              → `state.window.active.windowTitle`
//
// Two more waits need no fold: `file` (the folder tells when a path comes to exist or changes, fs.watch)
// and `after` (a plain timer). What is playing is not folded (only that something plays), so there is
// no wait for a track.
//
// The wait itself ends on the fold's own "something changed" event (`changed`, wired in index.js): no
// fast poll, only a slow one behind it for the case the event is missed.
//
// So it is a read, not an act: no approval, no side effect, nothing on the record but the answer it
// gives back. It ends the moment the fact is true, and when it is not true in time it says what it saw
// instead, which is the honest answer and never a guess.
//
// Named exports only.
import { existsSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { openedByOwner } from './gate.js'

const SECONDS_MAX = 180
/** Set 4 R2: a job wait asked for longer than this goes on the shelf (await-shelf.ts knocks when the job ends) instead of holding the turn. */
export const SHELF_AFTER_S = 60
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** The waits that are open, and the call that ends them all: `changed(ms)` ends at the next `wake()`, or after `ms`. */
export function wakes() {
  const open = new Set()
  return {
    wake: () => { for (const done of [...open]) done() },
    changed: (ms) => new Promise((resolve) => {
      const done = () => { clearTimeout(timer); open.delete(done); resolve() }
      const timer = setTimeout(done, ms)
      open.add(done)
    }),
  }
}

/** A file that comes to exist or changes within `ms`: `{ was, size }`, or null. The folder tells (fs.watch); nothing is polled. */
export function fileChanged(path, ms) {
  const stamp = () => { try { const { size, mtimeMs } = statSync(path); return { size, mtimeMs } } catch { return null } }
  const was = stamp()
  return new Promise((resolve) => {
    const end = (found) => { clearTimeout(timer); watcher.close(); resolve(found) }
    const check = () => { const now = stamp(); if (now && (now.size !== was?.size || now.mtimeMs !== was?.mtimeMs)) end({ was, size: now.size }) }
    const watcher = watch(dirname(path), (_kind, name) => { if (name === basename(path)) check() })
    const timer = setTimeout(() => end(null), ms)
    // Made between the first read and the watch: that counts.
    check()
  })
}

/** The window as the fold holds it, in the two fields a wait asks about. */
const now = (state) => ({
  app: String(state?.window?.active?.processName ?? ''),
  title: String(state?.window?.active?.windowTitle ?? ''),
})

/**
 * What the owner asked to wait for, as one test over the state, or an error saying why it cannot be one.
 *
 * `job` is exact. `app` and `window` are "it is there now", which is what the model means by "wait until
 * the app opens": if it is already there when the wait starts, the wait is over, and saying so at once is
 * better than blocking for nothing.
 */
export function waitFor(args, was) {
  const job = typeof args?.job === 'string' ? args.job.trim() : ''
  const app = typeof args?.app === 'string' ? args.app.trim() : ''
  const window = typeof args?.window === 'string' ? args.window.trim() : ''
  const gone = typeof args?.gone === 'string' ? args.gone.trim().toLowerCase() : ''
  if (job) return { what: `the job ${job} to finish`, test: (state) => state?.jobs?.[job] ?? null }
  // Runs 175-178 T14: a title that reads "..., loading" already holds every word the model could name, so a window
  // wait came back at once and it fell back to timers. `gone` is the wait for those words to leave the title.
  if (gone) return { what: `the front window's title to lose ${JSON.stringify(gone)}`, test: (state) => (now(state).title && !now(state).title.toLowerCase().includes(gone) ? now(state) : null) }
  // Run 15: the task was "an app will open itself, tell me which" — a wait it could not name, so it
  // slept 30 s instead. With nothing named, the wait is for the front app to become a different one.
  if (!app && !window) return { what: `the app in front to stop being ${was.app || 'none'}`, test: (state) => (now(state).app && now(state).app !== was.app ? now(state) : null) }
  if (app && window) return { what: `a window of ${app} whose title holds ${JSON.stringify(window)}`, test: (state) => (now(state).app === app && now(state).title.toLowerCase().includes(window.toLowerCase()) ? now(state) : null) }
  if (app) return { what: `${app} to be the app in front`, test: (state) => (now(state).app === app ? now(state) : null) }
  if (window) return { what: `a window whose title holds ${JSON.stringify(window)}`, test: (state) => (now(state).title.toLowerCase().includes(window.toLowerCase()) ? now(state) : null) }
  return { error: 'invalid arguments: nothing to wait for' }
}

/** Run 84 T03: the latest message's time (else the turn's start) while no tool has answered since, else null; `after` then counts from it. */
export function turnStart(events, pastTools = false) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const { type, time, data } = events[i] ?? {}
    if (type === 'tool/result' && !pastTools) return null
    if (type === 'user/message' && (data?.source?.plugin === 'compact' || data?.source?.kind === 'compact-checkpoint')) continue
    if (type === 'user/message' || type === 'turn/start') return Number(time) || null
  }
  return null
}

/** Set 3 R3: when the turn itself began (its newest `turn/start`, ms), else null. A message injected into a running turn (a notice, a bring, a correction) does not move it. */
export function turnBegan(events) {
  return Number((events ?? []).findLast((e) => e?.type === 'turn/start')?.time) || null
}

/** Run 97 T06: `{ at, before }` when `app`, in front now, came there after `turn` (ms) and `before` was in front at `turn`, from window rows `{ app, at }` newest first; else null. */
export function cameToFront(rows, app, turn) {
  const list = (rows ?? []).map((row) => ({ app: row.app, t: Date.parse(row.at) }))
  const before = list.findIndex((row) => row.t <= turn)
  const run = list.findIndex((row) => row.app !== app)
  return before !== -1 && run > 0 && list[before].app !== app ? { at: list[run - 1].t, before: list[before].app } : null
}

const shown = (app) => (app === '[hidden]' ? 'a hidden app' : app)

/** Run 97 T06: when the last screen_act (direct or through gnomon_call) answered in `events`, else 0; an app Gnomon fronted is not "it already happened". */
export function lastActAt(events) {
  const acts = new Set((events ?? []).filter((e) => e?.type === 'assistant/message').flatMap((e) => e.data?.message?.content ?? [])
    .filter((b) => b?.type === 'tool-call' && (b.name === 'screen_act' || (b.name === 'gnomon_call' && /"name"\s*:\s*"screen_act"/.test(String(b.arguments))))).map((b) => b.id))
  return Number((events ?? []).findLast((e) => e?.type === 'tool/result' && acts.has(e.data?.message?.toolCallId))?.time) || 0
}

/** What to say about a job that ended, in the words the answer needs: it says plainly when it failed. */
const jobLine = (job, found) => `The job ${job} finished after ${Math.round((found.ms ?? 0) / 1000)}s with exit code ${found.exitCode}${found.exitCode === 0 ? '' : ' (it FAILED: say so, do not report it as done)'}.${found.lastLine ? ` Its last line: ${JSON.stringify(found.lastLine)}` : ' It printed nothing.'}`

/**
 * `lastShell(session)`: this chat's last gnomon_run_shell, `{ at, failed, job, running }` (index.js). Run 36 T01: an empty wait
 * sent beside a gnomon_run_shell that failed waited 60 s for the app in front to change; it was meant for the job.
 * Set 2 R3: read from the fold (`state.shells`, rules shell-jobs.ts), so a restart keeps it; `at` is the row's time in ms;
 * a job runs while `state.jobs` has no `shell:exited` for it. One started before this process booted (`bootAt`, ms) is
 * `lost`: the restart killed it and no exit row will come, so it is not running.
 */
const BOOT_AT = Date.now() - process.uptime() * 1000
export function shellOf(state, session, bootAt = BOOT_AT) {
  const row = state?.shells?.[typeof session === 'string' ? session : '']
  if (!row) return null
  const at = Date.parse(row.at)
  const open = Boolean(row.job) && state?.jobs?.[row.job] === undefined
  const lost = open && at < bootAt
  return { at, failed: row.failed === true, job: row.job ?? undefined, running: open && !lost, ...(lost ? { lost: true } : {}) }
}

/** Whether `lsappinfo list` output holds the app as Swift resolves one: its name, case-insensitive, exact or a part of it. */
export const appIn = (out, app) => {
  const want = String(app).trim().toLowerCase()
  return want !== '' && [...String(out).matchAll(/^\s*\d+\) "(.*)" ASN:/gm)].some((m) => m[1].toLowerCase().includes(want))
}

/** A title that says the page or window is not ready yet. */
const LOADING = /\bloading\b/i

/** `lookAt(app, exec)`: the text screen_look gives for the app (index.js runs it through dsh's pipeline), or null. `shelve(row)` appends `await:shelved`. */
export function awaitTool(getState, changed = (ms) => sleep(Math.min(ms, 200)), lastShell = () => null, running = async () => false, windows = async () => [], startedAt = async () => null, titleOf = async () => null, lookAt = async () => null, shelve = null) {
  return defineTool({
    name: 'gnomon_await',
    description:
      'Wait for a sign instead of sleeping or guessing how long something takes; it comes back the moment the sign is true, with what it found, or after `seconds` with what was there instead. Give ONE of: job (the jobId a background gnomon_run_shell gave), app (until that app is in front; one that runs behind another is said after 3 s), window (until the front window\'s title holds these words, as a new track\'s does; app and window together allowed), gone (until the window title of app, else of the app last looked at, no longer holds these words: a page whose title says loading), file (a whole path: until it exists or changes), or nothing at all (until the app in front changes: how to watch for something you cannot name, or an app opening by itself). after is a plain timer for a time the owner asked for ("let it play 20 seconds"), never to give an app time: every screen_act already waited for the screen to settle. After a timed wait, act at once and read the clock after the act. Never sleep in a shell to wait for any of these. A job that may take longer than a minute: give seconds over 60 and about; it goes on the shelf, the owner is free, and a knock brings the result.',
    parameters: {
      job: { type: 'string', description: 'The jobId of a background command.' },
      app: { type: 'string', description: 'An app name: wait until it is the app in front.' },
      window: { type: 'string', description: 'A part of a window title, as it would be shown.' },
      gone: { type: 'string', description: 'Words in the window title now ("loading"): wait until they are gone from it. Give app with it.' },
      file: { type: 'string', description: 'A whole path ("~/Downloads/report.pdf"): wait until it comes to exist, or changes.' },
      after: { type: 'number', description: `Seconds to wait, only for a time the owner asked for; alone. At most ${SECONDS_MAX}.` },
      seconds: { type: 'number', description: `How long to wait at most (default 60, at most ${SECONDS_MAX}). Over ${SHELF_AFTER_S} for a job: it goes on the shelf.` },
      about: { type: 'string', description: 'With a job: what it is in two or three words ("the build", "the tests"), said to the owner while it waits on the shelf.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { happened: { type: 'boolean' }, text: { type: 'string' }, waited: { type: 'number' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      // Nothing named, right after this chat's shell call: its running job is the wait, and one that never started is said at once.
      const last = ['job', 'app', 'window', 'gone', 'file', 'after'].some((k) => args?.[k] !== undefined && args[k] !== '') ? null : lastShell(exec?.agent?.session?.id)
      const shell = last && Date.now() - last.at < 10_000 ? last : null
      if (shell?.lost) return { happened: false, waited: 0, text: `Nothing is running: the job ${shell.job} started before Sundial restarted, so it is gone and no exit will come. Start it again (gnomon_run_shell {command, background: true}) if it is still needed.` }
      if (shell?.job) args = { ...args, job: shell.job }
      else if (shell?.failed) return { happened: false, waited: 0, text: 'Nothing is running: the gnomon_run_shell call before this wait did not start a job. Start the job first (gnomon_run_shell {command, background: true}), then gnomon_await {job: the jobId it gives}.' }
      const seconds = Math.min(SECONDS_MAX, Math.max(1, Number(args?.seconds) || 60))
      const started = Date.now()
      const waited = () => Math.round((Date.now() - started) / 1000)
      if (Number(args?.after) > 0) {
        const after = Math.min(SECONDS_MAX, Number(args.after))
        const events = exec?.agent?.session?.snapshotEvents?.()
        const turn = turnStart(events)
        if (turn === null) {
          await sleep(after * 1000)
          return { happened: true, waited: waited(), text: `${waited()}s went by. Nothing was watched: look or read before you say what changed.` }
        }
        const thinking = Math.max(0, Math.round((started - turn) / 1000))
        await sleep(Math.max(0, after - thinking) * 1000)
        return { happened: true, waited: waited(), text: `Waited until ${after}s after ${openedByOwner(events) ? 'your message' : 'the turn began'} (${thinking}s of it went to thinking). Nothing was watched: look or read before you say what changed.` }
      }
      if (typeof args?.file === 'string' && args.file.trim() !== '') {
        const path = args.file.trim().replace(/^~(?=\/)/, homedir())
        if (!isAbsolute(path) || !existsSync(dirname(path))) throw new Error('invalid arguments: file is a whole path in a folder that exists, like "~/Downloads/report.pdf"')
        const found = await fileChanged(path, seconds * 1000)
        // Runs 175-178: told only "changed", the model waited on the file again instead of reading it.
        if (found) return { happened: true, waited: waited(), text: `${path} ${found.was ? 'changed' : 'is there now'} (${found.size} bytes). Waited ${waited()}s. Read the file next to see what it holds; do not wait on it again.` }
        return { happened: false, waited: seconds, text: `${path} did not ${existsSync(path) ? 'change' : 'come to exist'} in ${seconds}s. Say it did not happen; do not say it did.` }
      }
      const was = now(getState())
      const want = waitFor(args, was)
      if (want.error) throw new Error(want.error)
      // Set 4 R2: a job wait past a minute holds no turn. It goes on the shelf (await-shelf.ts knocks when the job's row lands),
      // the turn ends with one line, and the owner's next words start a fresh one. A job that already ended is answered below.
      if (args.job && shelve && Number(args?.seconds) > SHELF_AFTER_S && !want.test(getState())) {
        const about = String(args.about ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'the job'
        await shelve({ sessionId: String(exec?.agent?.session?.id ?? ''), job: args.job, about })
        return { happened: false, waited: 0, text: `On the shelf: Waiting for ${about}, I will knock.\nThe job ${args.job} runs on; when it ends, a knock in this chat brings its result. Say that one line to the owner and end your turn: no other call, no other wait.` }
      }
      const lookedApp = () => String(args.app ?? '').trim() || String(getState()?.marks?.lastLook?.app ?? '') || was.app
      // Run 189 T14: a window wait for "Testbox order desk" came back at once on "Testbox order desk, loading", and the
      // model looked and waited again. A window whose title holds the words and says loading is not there yet: wait for that to go.
      if (args.window && !args.gone) {
        const title = await titleOf(lookedApp()).catch(() => null)
        if (title && LOADING.test(title) && title.toLowerCase().includes(String(args.window).trim().toLowerCase())) args = { ...args, gone: 'loading' }
      }
      // Runs 179-182 T14: the fold's front window was Finder's while the page loaded in Zen behind it (an answer at once),
      // or a title Zen changed under the slip never reached the fold (30 s for a page ready after 8). `gone` reads the
      // app's own window, the app named, else the one last looked at, by a short look about every second.
      if (typeof args?.gone === 'string' && args.gone.trim() !== '') {
        const words = args.gone.trim().toLowerCase()
        const app = lookedApp()
        let title = ''
        for (const end = started + seconds * 1000; ; await sleep(Math.min(700, end - Date.now()))) {
          title = (await titleOf(app).catch(() => null)) ?? (now(getState()).app === app ? now(getState()).title : '')
          if (title && !title.toLowerCase().includes(words)) {
            // Runs 183, 186, 187: the model looked again after every wait (5 steps where 4 are the bar). The look comes with it.
            const seen = await lookAt(app, exec).catch(() => null)
            return { happened: true, waited: waited(), text: `${app}'s window is ${JSON.stringify(title)} now. Waited ${waited()}s. ${seen ? `Its look, taken now: act on a ref from it at once, with no new look.\n${seen}` : 'Act at once: a step by its label needs no new look.'}` }
          }
          if (Date.now() >= end) break
        }
        return { happened: false, waited: seconds, text: `${app}'s window still held ${JSON.stringify(words)} after ${seconds}s${title ? ` (${JSON.stringify(title)})` : ''}. Say it did not happen; do not say it did.` }
      }
      const events = exec?.agent?.session?.snapshotEvents?.()
      const turn = !args.job && !args.app && !args.window && !args.gone && was.app ? turnStart(events, true) : null
      const came = turn === null ? null : cameToFront(await windows().catch(() => []), was.app, Math.max(turn, lastActAt(events)))
      // It counts only when the app's process started after the message: the owner switching to a running app is not it.
      const born = came ? await startedAt(was.app).catch(() => null) : null
      if (born !== null && born > turn - 1000) {
        const msg = openedByOwner(events) ? 'your message' : 'the turn began'
        return { happened: true, waited: 0, text: `${shown(was.app).replace(/^a /, 'A ')} has been in front since ${new Date(came.at).toLocaleTimeString('en-GB')} (${Math.round((came.at - turn) / 1000)}s after ${msg}); at ${msg} it was ${shown(came.before)}.` }
      }
      // Run 76 T03: an app still behind another after 3 s, yet running, will not open: say so instead of waiting the whole time.
      const app = typeof args?.app === 'string' && !args.window && !args.gone ? args.app.trim() : ''
      let asked = false
      for (const end = started + seconds * 1000; Date.now() < end; ) {
        // The wait is armed before the read, so a change that lands between the two is not missed.
        const next = changed(Math.min(1000, end - Date.now()))
        const found = want.test(getState())
        if (!found) {
          if (app && !asked && Date.now() - started >= 3000) {
            asked = true
            if (await running(app)) return { happened: false, waited: waited(), text: `${app} has been running the whole time, behind ${now(getState()).app || 'no app'}: it did not just open.` }
          }
          await next
          continue
        }
        const text = args.job ? jobLine(args.job, found) : `${found.app} is in front, its window is ${JSON.stringify(found.title)}.`
        return { happened: true, waited: waited(), text: `${text} Waited ${waited()}s.` }
      }
      const there = now(getState())
      return {
        happened: false,
        waited: seconds,
        text: `${want.what} did not happen in ${seconds}s. What is there now: ${there.app || 'no app'}${there.title ? `, window ${JSON.stringify(there.title)}` : ''}. Say it did not happen; do not say it did.`,
      }
    },
  })
}
