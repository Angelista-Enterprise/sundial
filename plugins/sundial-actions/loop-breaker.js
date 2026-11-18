// The loop breaker, the shell-hunt cap and the screen-hunt cap: per-turn limits read from the chat's own log (the dsh
// session's `tool/call` and `tool/result` events), never from a module counter. Rig runs 190, 193 and 198 spent their 180 s
// on the same failing screen step (rename, File > Rename, list view, set-value e73 three times); runs 179, 183 and
// 198 T17 ran 11 to 17 read-only shell searches after a screen step failed. lab/screen-rig/loops.mjs replays both
// over the record, and chose the limits. Runs 238 and 240 T27 hunted 43 and 15 steps for a button Calculator does not
// have: every step worked (a menu, a sidebar, a scroll, another view), so none was a miss; only the looks for it found nothing.

import { privateApp } from './gate-finals.js'
import { shellWrite } from './gate.js'

/**
 * `fails`: a thing on screen that failed or changed nothing this many times in a turn, and the next act on it is refused.
 * `same`: the same call with the same arguments this many times in a row, and the next one is refused.
 * `hunt`: this many read-only shell commands in a row (since the last act) in a turn where a screen call failed, and the next is refused.
 * `seek`: this many looks in a turn whose query found nothing for a word, an act between each two, nothing since showing it, and the next look or act for it is refused.
 */
export const LIMITS = { fails: 4, same: 2, hunt: 4, seek: 2 }

const ACTS = new Set(['screen_act', 'screen_undo'])
const SCREEN = new Set([...ACTS, 'screen_look', 'screen_mark', 'screen_guide', 'gnomon_pull_up'])
/** Calls that act on the screen: a shell read after one is a check of what it did, not a hunt. */
const MOVES = new Set([...ACTS, 'screen_mark', 'screen_guide', 'gnomon_pull_up'])
const SHELLS = new Set(['gnomon_run_shell', 'bash'])
/** Calls that are fine to repeat word for word: a look or a wait after something changed reads a new screen. */
const REPEATS = new Set(['screen_look', 'gnomon_await', 'todo_write'])
/** In every refusal, so a later call in the same turn knows the breaker already spoke. */
const MARK = 'Gnomon stopped this turn:'
const ASK = 'Say what you tried and what you saw, and ask the owner how to go on.'

const parse = (raw) => {
  if (raw && typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw ?? ''))
  } catch {
    return {}
  }
}
/** The tool a call meant: its own, or the one inside gnomon_call. */
export function callOf(name, raw) {
  const args = parse(raw)
  if (name !== 'gnomon_call' || typeof args?.name !== 'string') return { name, args }
  return callOf(args.name, args.args ?? {})
}
const textOf = (message) => (message?.content ?? []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
const ownerSaid = (e) => e?.type === 'user/message' && e.data?.source?.kind === 'user' && e.data.source.form === undefined
/** dsh's compaction checkpoint: what came before it is condensed out of the model's context. */
export const checkpoint = (e) => e?.type === 'user/message' && (e.data?.source?.plugin === 'compact' || e.data?.source?.kind === 'compact-checkpoint')
/** Set 3 R3: when the chat's context last began (its newest compaction checkpoint, ms), else 0: a read before it is out of the model's context. */
export const contextBegan = (events) => Number((events ?? []).findLast(checkpoint)?.time) || 0
/** The calls from `start` on that have answered, oldest first: `{ name, args, text, isError }`. */
function callsFrom(list, start) {
  const tail = list.slice(start)
  const results = new Map(tail.filter((e) => e?.type === 'tool/result').map((e) => [e.data?.message?.toolCallId, e.data.message]))
  return tail
    .filter((e) => e?.type === 'tool/call' && results.has(e.data?.callId))
    .map((e) => ({ ...callOf(e.data.name, e.data.arguments), text: textOf(results.get(e.data.callId)), isError: results.get(e.data.callId)?.isError === true }))
}

/**
 * The calls of the current turn that have answered, oldest first: `{ name, args, text, isError }`. The turn starts at its
 * `turn/start`, or at the owner's newest message inside it (a correction is a new goal). The call being decided has no
 * result yet, so it is never in the list.
 */
export function turnCalls(events) {
  const list = events ?? []
  const start = list.findLastIndex((e) => e?.type === 'turn/start' || ownerSaid(e))
  return start < 0 ? [] : callsFrom(list, start)
}

/**
 * Set 3 R3, the gate's private words: the chat's calls still in the model's context, across turns, from its newest compaction
 * checkpoint on (from the start when there is none), the newest `max`.
 */
export function contextCalls(events, max = 200) {
  const list = events ?? []
  return callsFrom(list, Math.max(0, list.findLastIndex(checkpoint))).slice(-max)
}

/**
 * A call refused for its own shape: its arguments, the gate, or a set-value that needs `replace: true` (the owner's
 * text is put back). The model fixes those; they are not the screen saying no.
 */
const unsent = (text) => /^(Error: )?(step \d+: )?(invalid arguments|Gnomon: )/.test(text) || /already held the owner's text/.test(text)
/** Steps the act tool could read: a list, or one step at the top level (run 185 nested them in `item`, and the act read none). */
const stepsOf = (args) => (args?.steps === undefined ? [args ?? {}] : Array.isArray(args.steps) ? args.steps : null)
/**
 * Doc 31 (run 257 T19): a "look again" refusal (the ref is stale, or the app would not resolve it) says nothing of the thing:
 * four of them on the go-to field ended the turn one Return short. It is no miss; the same call again still counts (`same`).
 */
const stale = (call) => ACTS.has(call.name) && call.isError && /\brefused: (?:\S+ is in no recent look of [^:\n]+: )?look again\b/.test(call.text)
/** A screen act that failed, was refused by the app, or changed nothing on screen. */
export const missed = (call) => ACTS.has(call.name) && stepsOf(call.args) !== null && !unsent(call.text) && !stale(call) && (call.isError || /nothing on screen changed/i.test(call.text))
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
/**
 * The things a screen act's steps name: a ref without its window part, a label, a text, a menu path. Not its goal: a
 * model keeps one goal over a form it fills in four calls (run 182 T08), so a goal is no target.
 */
export function thingsOf(args) {
  const app = norm(args?.app)
  const things = (stepsOf(args) ?? []).map((s) => {
    const target = s?.target && typeof s.target === 'object' ? s.target : {}
    const thing = String(s?.ref ?? target.ref ?? '').split('@')[0] || s?.label || s?.text || target.label || target.text || (/menu/.test(String(s?.action)) ? s?.value : '')
    return thing ? `${norm(s?.app ?? app)}\n${norm(thing)}` : ''
  })
  return [...new Set(things.filter(Boolean))]
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** A shell command that only reads or searches. */
export const shellRead = (args) => typeof args?.command === 'string' && args.command.trim() !== '' && (shellWrite(args.command) === null || /(^|[\s;|&(])(find|mdfind|locate)\s/.test(args.command))

/** The loop breaker: a refusal line, or null. */
export function loopRefusal(name, args, calls, limits = LIMITS) {
  if (ACTS.has(name)) {
    const tried = calls.filter((c) => c.name === name && missed(c))
    // A private app's screen text never goes into the line: it lands on the record as the stop's reason.
    const hidden = [args?.app, ...(stepsOf(args) ?? []).map((s) => s?.app)].some(privateApp)
    for (const thing of thingsOf(args)) {
      const n = tried.filter((c) => thingsOf(c.args).includes(thing)).length
      if (n >= limits.fails) return `${MARK} acting on ${hidden ? 'one thing in a private app' : `"${thing.split('\n')[1]}"`} failed or changed nothing ${n} times in this turn. Do not try it again in another way. ${ASK}`
    }
  }
  // A read-only shell command polls (git status, a port coming up): the same one again is a wait, not a loop.
  if (REPEATS.has(name) || (SHELLS.has(name) && shellRead(args))) return null
  // The same call again with nothing done in between (looks and waits aside). A screen act counts only when it missed: Next, Next, Next is a flow.
  const run = calls.filter((c) => !REPEATS.has(c.name))
  const repeats = run.length - 1 - run.findLastIndex((c) => !(c.name === name && same(c.args, args) && (!ACTS.has(name) || missed(c) || stale(c))))
  return repeats >= limits.same ? `${MARK} this exact ${name} call already ran ${repeats} times in a row and did not get you further. Do not run it again. ${ASK}` : null
}

/** A screen call that failed on the screen's side: an act that missed, or a look the app refused (runs 175-187 T09: "not-running"). */
const failedScreen = (call) => missed(call) || (SCREEN.has(call.name) && call.isError && !unsent(call.text))

/** The shell-hunt cap: a refusal line, or null. Read-only shell commands since the last act, in a turn where a screen call failed. */
export function huntRefusal(name, args, calls, limits = LIMITS) {
  if (!SHELLS.has(name) || !shellRead(args) || !calls.some(failedScreen)) return null
  const n = calls.slice(calls.findLastIndex((c) => MOVES.has(c.name)) + 1).filter((c) => SHELLS.has(c.name) && shellRead(c.args)).length
  return n >= limits.hunt ? `${MARK} ${n} shell searches in a row in this screen task. Stop searching: say what you found and what you could not do, and ask the owner if it is not done.` : null
}

/** Words that name no thing of their own: a look for "Archive button" is a look for "archive". */
const PLAIN = new Set(['the', 'and', 'for', 'with', 'button', 'field', 'menu', 'item', 'tab', 'link', 'icon', 'row', 'box', 'control', 'element', 'window', 'page', 'screen', 'bar', 'list'])
const wordsOf = (...texts) => [...new Set(texts.filter((t) => typeof t === 'string').flatMap((t) => norm(t).split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3 && !PLAIN.has(w)))]
/** What a screen call looks for: a look's query; an act's things by name and its reasons (`because`), which name what a menu, a sidebar or a view switch was for. */
// Run 252 T21: a folder named in a Save panel's path step (save-as, go-to-folder) is where the file goes, never a hunt for it.
function seeks(name, args) {
  if (name === 'screen_look') return wordsOf(args?.query)
  if (name !== 'screen_act') return []
  const steps = stepsOf(args) ?? []
  const path = wordsOf(...[args, ...steps].filter((s) => /^(?:save-as|go-to-folder)$/.test(String(s?.action ?? '').trim())).map((s) => s.value))
  return wordsOf(args?.because, args?.find, args?.label, args?.text, ...steps.flatMap((s) => [s?.because, s?.find, s?.label, s?.text, s?.target?.label, s?.target?.text, /menu/.test(String(s?.action)) ? s?.value : null])).filter((w) => !path.includes(w))
}

/**
 * The screen-hunt cap: a refusal line, or null. A word whose looks found nothing `seek` times in the turn ("Nothing matches",
 * and no screen text holds it either), an act between each two, with no look since that shows it, is not there: the next
 * look or act that names it (a query, a thing by name, a `because`) is refused.
 * Not a stop of the turn: the rest of the task goes on. Run 252 T21: a shell command whose output shows the word (a folder
 * listing) found it too, as a look that shows it does.
 */
export function seekRefusal(name, args, calls, limits = LIMITS) {
  const want = seeks(name, args)
  if (want.length === 0) return null
  const misses = new Map()
  // A miss counts once per change: a look again with nothing done since (a page still drawing, a wait) is the same miss.
  for (const [i, c] of calls.entries()) {
    if (SHELLS.has(c.name) && !c.isError) for (const w of misses.keys()) if (wordsOf(c.text).includes(w)) misses.delete(w)
    if (c.name !== 'screen_look' || c.isError) continue
    const asked = wordsOf(c.args?.query)
    const none = asked.length > 0 && /Nothing matches "/.test(c.text) && !/The screen text the app shows also holds/.test(c.text)
    const was = (w) => misses.get(w) ?? { n: 0, at: -1, query: String(c.args.query).trim() }
    const counts = (w) => !misses.has(w) || calls.slice(was(w).at + 1, i).some((x) => ACTS.has(x.name))
    if (none) for (const w of asked) misses.set(w, counts(w) ? { ...was(w), n: was(w).n + 1, at: i } : was(w))
    // Any other look that shows the word (a match, a menu's items, a whole window) found it; its own echo of a query is no showing.
    else for (const w of misses.keys()) if (wordsOf(c.text.replace(/match\w* "[^"]*"/gi, '')).includes(w)) misses.delete(w)
  }
  const gone = want.map((w) => misses.get(w)).find((m) => m && m.n >= limits.seek)
  return gone ? `"${gone.query}" is not there: ${gone.n} looks for it in this turn found nothing, and no look since showed it. Do not look for it again, in a menu, a sidebar or another view either: say plainly that ${JSON.stringify(gone.query)} is not there, and go on with the rest of the task.` : null
}

/**
 * The verdict for one call: `{ kind: 'deny', reason, breaker, app }` or null. Once a screen act has been stopped in a
 * turn, every later screen act and shell command in it is refused too: the line said stop. screen_undo stays free, so
 * the owner's replaced text can still be put back. A call outside a turn (an offer pressed on an idle chat) starts fresh.
 */
export function breakerOf(name, rawArgs, events, limits = LIMITS) {
  const { name: tool, args } = callOf(name, rawArgs)
  const list = events ?? []
  if (list.findLastIndex((e) => e?.type === 'turn/end') > list.findLastIndex((e) => e?.type === 'turn/start')) return null
  const calls = turnCalls(list)
  // The app the stop is about, for the self-review: the call's own, else the turn's last screen app (a shell call names none).
  // A private app is never named on the record.
  const named = [args, ...calls.map((c) => c.args).reverse()].find((a) => typeof a?.app === 'string')?.app ?? null
  const app = privateApp(named) ? null : named
  if (((ACTS.has(tool) && tool !== 'screen_undo') || SHELLS.has(tool)) && calls.some((c) => ACTS.has(c.name) && c.text.includes(MARK))) return { kind: 'deny', reason: `${MARK} you were told to stop. Answer now. ${ASK}`, breaker: 'loop', app }
  const loop = loopRefusal(tool, args, calls, limits)
  if (loop) return { kind: 'deny', reason: loop, breaker: 'loop', app }
  const seek = seekRefusal(tool, args, calls, limits)
  if (seek) return { kind: 'deny', reason: seek, breaker: 'seek', app }
  const hunt = huntRefusal(tool, args, calls, limits)
  return hunt ? { kind: 'deny', reason: hunt, breaker: 'hunt', app } : null
}
