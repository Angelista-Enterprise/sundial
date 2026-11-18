// gnomon_pull_up (NEXT 3.2, Set 2 Round 1): the owner says "pull up Tuesday's memo" and the thing is on screen, placed and
// ringed, in one model step. It composes what exists, and every inner call goes through dsh's own pipeline (tools.execute,
// as gnomon_call does), so the gate, the approval and the audit run for each under its own name:
//   find   the owner's own windows of the last half hour first (the log's window, input and act rows), the one they typed
//          in last for "the document I was editing a few minutes ago"; then gnomon_semantic_search and gnomon_moment_detail
//          for older things (runs 163 to 166: a one-minute-old edit is in no closed or embedded moment yet)
//   open   screen_act: a page by its address, a window by its title; a closed document by its path (gnomon_run_shell open),
//          else the app's File > Open Recent (the owner approves each as usual)
//   place  not staged: the raise already puts it in front, and the stage puts its windows back when the turn ends, which
//          would snap the thing away right after the answer (Fable's review of Set 2 Round 1)
//   mark   screen_mark on the ref the after-look shows for the part that matters
// Measure: a screen:pull-up row at the start and one at the end naming the mark, whose screen:mark-placed row the app writes.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js'
import { isSystemProcess } from '@sundial/helpers/window-classification.js'
import { BROWSERS, oneOf, privateApp } from './gate.js'
import { lookOf, prune, tagOf } from './screen-look.js'

const STOP = new Set(['the', 'that', 'this', 'was', 'were', 'with', 'from', 'for', 'and', 'you', 'your', 'mine', 'one', 'its', 'what', 'which', 'show', 'pull', 'bring', 'open', 'last', 'yesterday', 'today', 'earlier', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'morning', 'afternoon', 'week', 'document', 'file', 'page', 'window', 'editing', 'edited', 'writing', 'working', 'reading', 'few', 'minutes', 'minute', 'ago', 'just', 'now', 'moment', 'recent', 'recently', 'line', 'changed', 'point',
  // File extensions (run 173: "txt" of "Log Tamarind.txt" matched every .txt window, "Brief Kestrel.txt" included).
  'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'htm', 'html', 'csv', 'xls', 'xlsx', 'ppt', 'pptx', 'json', 'png', 'jpg', 'jpeg'])
/** The words that name the thing: three letters or more, no possessive, no day or filler. */
export const wordsOf = (text) => (String(text ?? '').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w))
/** The rig's own test windows (its mail box, its fixture pages): never the owner's work. The same test as the byGnomon rule. */
const rigWindow = (title) => title.includes('Testbox') || title.startsWith('Rig fixture:')
const score = (text, words) => words.filter((w) => text.toLowerCase().includes(w)).length
/** The best of `list` for the words, the latest on a tie (a moment lists its titles as they came). */
const best = (list, words) => list.reduce((b, x) => (b === null || score(x, words) >= score(b, words) ? x : b), null)

/**
 * Where a moment's thing is, for these words, when the moment is the owner's: `{app, window?, url?, label, symbol?}`, else null.
 * Moments are folded owner-only (byGnomon, rigSessions), so a row Gnomon caused never reaches one; a moment wholly inside
 * the fold's last run of acts in that app, Sundial's own window and the rig's windows are still left out here.
 */
export function placeOf(moment, words, state) {
  const app = String(moment?.processName ?? '')
  if (!app || moment.error || app === 'Sundial' || isSystemProcess(app)) return null
  const run = state?.byGnomon
  const [from, to] = [Date.parse(moment.startTime ?? ''), Date.parse(moment.endTime ?? moment.startTime ?? '')]
  if (run?.since && run.until && (run.apps ?? []).includes(app) && from >= Date.parse(run.since) && to <= Date.parse(run.until)) return null
  const data = moment.data ?? {}
  const titles = (data.windowTitles ?? []).filter((t) => typeof t === 'string' && t !== '' && !isRedactedPlaceholder(t) && !rigWindow(t))
  if ((data.windowTitles ?? []).length > 0 && titles.length === 0) return null
  const symbol = [...(data.symbolsEdited ?? [])].reverse().find((s) => typeof s === 'string' && s.length > 2)
  const base = { app, ...(symbol ? { symbol } : {}) }
  if (isRedactedPlaceholder(app) || privateApp(app)) return { ...base, private: true }
  const page = oneOf(BROWSERS, app) ? best((data.pages ?? []).filter((p) => typeof p === 'string' && p !== ''), words) : null
  if (page && score(page, words) > 0) return { ...base, url: `https://${page}`, label: page }
  const window = best(titles, words)
  return window ? { ...base, window, label: window } : { ...base, label: app }
}

/** A request for whatever was last worked on, not for a thing by name. */
const RECENT = /\b(just( now)?|recent(ly)?|minutes? ago|a moment ago|was (editing|writing|working|reading|on|in)|had open)\b/i
const SETTLE_MS = 3_000
/** The fewest keys an input row must hold, outside the slip, to be an edit of the window in front. */
const MIN_KEYS = 2
const SCREEN_ACTS = new Set(['screen_act', 'screen_undo'])
const at = (row) => Date.parse(row.capturedAt)
/** Sundial's own windows (the slip, the web client's tab "Sundial") and anything private or the rig's: never the owner's work. */
const ownersWindow = (app, title) => app !== '' && app !== 'Sundial' && !isSystemProcess(app) && !isRedactedPlaceholder(app) && !privateApp(app) && !isRedactedPlaceholder(title) && !rigWindow(title) && !/^(Set up )?Sundial\b/.test(title)

/**
 * The owner's windows from the log's rows of the last half hour (window:changed, input:activity, action:decided and
 * action:performed), each `{app, window, path, seenAt, typedAt?}`. The fold's byGnomon mark is not on a row, so the same
 * window is read here: from a screen act's decision to its call row, plus the settle, a focus change is Gnomon's, and so are
 * the keys counted then. The rig's own typing in its fixtures comes through the keyboard like the owner's, so it counts.
 * An input row's keys go to the owner's window that was in front longest in its window, never Finder over a document.
 */
export function recentWork(rows) {
  const sorted = [...rows].filter((r) => Number.isFinite(at(r))).sort((a, b) => at(a) - at(b))
  const acts = []
  for (const r of sorted) {
    const tool = String(r.data?.action ?? r.data?.tool ?? '')
    if (!SCREEN_ACTS.has(tool)) continue
    if (r.eventType === 'decided') acts.push([at(r), at(r) + 60_000])
    else if (r.eventType === 'performed' && acts.length) acts.at(-1)[1] = at(r) + SETTLE_MS
  }
  const gnomon = (t) => acts.some(([a, b]) => t >= a && t <= b)
  // Runs 180-182: the keys of the request itself, typed into the slip (it moves no focus), made the window under it,
  // a Finder Info window, the one "typed in last". From a summon to its dismissal or the next window change, keys are the slip's.
  const slips = []
  for (const r of sorted) {
    // Run 173: a summon with no dismissal before the next summon stayed open to the end, and every key after it was the slip's.
    if ((r.eventType === 'summoned' || r.eventType === 'dismissed' || r.eventType === 'changed') && slips.at(-1)?.[1] === Infinity) slips.at(-1)[1] = at(r)
    if (r.eventType === 'summoned') slips.push([at(r), Infinity])
  }
  // The milliseconds of [a, b] the slip was not up. An input row is 10 s of counts, so a row that ends in the slip still
  // holds the keys from before it: run 184's 32-key edit of the fixture closed 2 s after the next task's summon and was
  // dropped whole, and then the summon's own one key, in a row of its own, made a Finder window the one "typed in last".
  const clip = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c))
  const outside = (a, b) => clip(a, b, a, b) - slips.reduce((n, [s, e]) => n + clip(a, b, s, e), 0)
  const spans = []
  const seen = new Map()
  for (const r of sorted.filter((r) => r.eventType === 'changed')) {
    if (spans.length) spans.at(-1).to = at(r)
    const app = String(r.data?.processName ?? '')
    const window = String(r.data?.windowTitle ?? '')
    // Gnomon's window, or one that is not the owner's work: a gap no keys go to.
    if (gnomon(at(r)) || !ownersWindow(app, window)) {
      spans.push({ one: null, from: at(r), to: Infinity })
      continue
    }
    const key = `${app}\n${window}`
    const one = seen.get(key) ?? { app, window }
    // Run 217 T13: the record keeps the path as sanitize-at-ingest wrote it, under "~/" for the home folder, so the closed
    // document was never opened by its path and Open Recent sat behind a sheet. The Mac's open takes it whole.
    const path = String(r.data?.documentPath ?? '').replace(/^file:\/\/(localhost)?/, '').replace(/^~(?=\/)/, homedir())
    seen.set(key, Object.assign(one, { seenAt: at(r), ...(path.startsWith('/') ? { path: decodeURI(path) } : {}) }))
    spans.push({ one, from: at(r), to: Infinity })
  }
  for (const r of sorted.filter((r) => r.eventType === 'activity' && !gnomon(at(r)))) {
    const [from, to] = [at(r) - (Number(r.data.windowMs) || 10_000), at(r)]
    // The keys of the part outside the slip, pro rata: fewer than MIN_KEYS is a summon, an arrow or a switch, never an edit.
    if ((Number(r.data.keyDownCount) || 0) * outside(from, to) < MIN_KEYS * (to - from)) continue
    // A Finder window is never the document edited (runs 180-184: the rig's neutral front, an Info window, won four times).
    const front = spans.map((s) => ({ one: s.one, ms: outside(Math.max(from, s.from), Math.min(to, s.to)) })).filter((s) => s.one && s.one.app !== 'Finder' && s.ms > 0)
    const win = front.sort((a, b) => b.ms - a.ms)[0]
    if (win) win.one.typedAt = to
  }
  return [...seen.values()]
}

/** The live window to pull up: for "what I was just doing", the last one typed in (else the last with a document); for a thing by name, one whose title holds its words, typed in first. */
export function pickRecent(work, words, recent) {
  const newest = (list, k) => list.filter((w) => w[k]).sort((a, b) => b[k] - a[k])[0] ?? null
  if (recent) return newest(work, 'typedAt') ?? newest(work.filter((w) => w.path), 'seenAt')
  const named = work.filter((w) => words.length && score(w.window, words) > 0)
  return newest(named, 'typedAt') ?? newest(named, 'seenAt')
}

/**
 * The thing to ring in the look after the open: the last thing edited, else a word of the request, else the caret's line, else
 * the document's body. `reopened`: the document was closed and opened again, so its caret is the app's fresh one, not where the
 * owner left it (runs 215 to 221 T13: "the line you were on is ringed (line 1)" every time, and run 219's model did not believe it).
 */
export function ringOf(look, place, words, reopened = false) {
  const things = prune(look?.elements).filter((e) => e.label !== look.window)
  const has = (w) => things.find((e) => `${e.label}\n${e.value}`.toLowerCase().includes(w.toLowerCase()))
  const symbol = place.symbol ? has(place.symbol) : null
  if (symbol) return { ref: symbol.ref, said: 'the part you last changed is ringed' }
  const title = String(look.window ?? '').toLowerCase()
  for (const w of words.filter((w) => !title.includes(w))) {
    const e = has(w)
    if (e) return { ref: e.ref, said: `${JSON.stringify(String(e.label || e.value).slice(0, 40))} is ringed` }
  }
  // Rig run205 T12: told only the body, the model hunted the line by shell and once named one from another file. The app
  // keeps the caret where the owner left it, and the look gives its line's number and frame (never a word of the text).
  const caret = reopened ? null : things.find((e) => e.caret?.ref && Number.isInteger(e.caret.line))?.caret
  if (caret) return { ref: caret.ref, said: `the line you were on is ringed (line ${caret.line})` }
  const body = things.find((e) => /TextArea|WebArea|Table|Outline/.test(e.role ?? ''))
  // Run 179: told only "the body is ringed" for "point at the line I changed", the model spent ten steps hunting the line.
  return body ? { ref: body.ref, said: 'the document body is ringed (keys are counted, never read, so which line changed is not on record)' } : null
}

/**
 * S5R2: whether a window of `app` whose title holds `name` is open, by the newest look (taken `at`, under 5 minutes ago): the app's own
 * window list when the look is of the app (minimized ones too), else the windows on screen. Null when no look can say. Runs
 * 211-221: a raise on a closed document left 11 "no-such-window" rows in 8 tasks, each one a failure the model then talked about.
 */
export function openNow(look, app, name, at, now = Date.now()) {
  if (!look || !name || !(now - Date.parse(at ?? '') < 5 * 60_000)) return null
  const titles = String(look.app).toLowerCase() === String(app).toLowerCase() ? [look.window, ...(look.windows ?? []).map((w) => w.title)] : Array.isArray(look.screen?.windows) ? look.screen.windows.filter((w) => String(w.processName).toLowerCase() === String(app).toLowerCase()).map((w) => w.windowTitle) : null
  return titles ? titles.some((t) => String(t ?? '').includes(name)) : null
}

const textOf = (result) => (result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || String(result?.error?.message ?? '')
const firstLine = (text) => String(text).split('\n')[0].replace(/^(Error: )?/, '').slice(0, 200).replace(/[.\s]+$/, '')

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** `tools` is dsh's registry (schemas + execute); `readLook(id, {at})` reads a look's row; `readRecent(from, to)` the log's rows for recentWork (index.js). */
export function pullUpTool({ tools, getState, appendSignal, readLook, readRecent = async () => [] }) {
  return defineTool({
    name: 'gnomon_pull_up',
    description:
      'Bring back up on the owner\'s screen something they worked on, in one call, named in the words of their newest message ("Tuesday\'s memo", "the stock list", "the document I was editing a few minutes ago"): it finds it in the record of what they did, opens or raises it (the owner approves as for screen_act), and rings the part that matters. Use it for "pull up", "show me", "bring up" instead of search and screen_act. Answer with its one sentence, nothing more. A private app is refused: say so.',
    parameters: {
      // Runs 173 and 174: one long thread, and the model sent the name of a document an EARLIER ask had found ("Log
      // Fennel.txt") for "the document I was editing a few minutes ago". The newest message's own words go in.
      what: { type: 'string', required: true, description: 'The thing, in the owner\'s words from their newest message, copied as they said them ("the document I was editing a few minutes ago"). Never a name you take from an earlier ask in this chat: that answered another question.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const what = String(args?.what ?? '').trim().slice(0, 120)
      if (!what) throw new Error('invalid arguments: what is the thing, in the owner\'s words ("Tuesday\'s memo")')
      const session = String(exec?.agent?.session?.id ?? '')
      const id = `pull-${randomUUID().slice(0, 8)}`
      const started = Date.now()
      let n = 0
      const call = (name, inner) => tools.execute({ callId: `${exec?.callId}:${name}:${n++}`, rootCallId: exec?.rootCallId ?? exec?.callId, name, arguments: inner, agent: exec?.agent, parent: exec?.token, signal: exec?.signal })
      const end = async (outcome, text, more = {}) => {
        await appendSignal('screen:pull-up', { id, phase: 'end', outcome, ms: Date.now() - started, ...(session ? { session } : {}), ...more }).catch(() => {})
        return text
      }
      await appendSignal('screen:pull-up', { id, phase: 'start', ...(session ? { session } : {}) }).catch(() => {})
      const words = wordsOf(what)
      const live = pickRecent(recentWork(await readRecent(new Date(started - 30 * 60_000).toISOString(), new Date(started + 1_000).toISOString()).catch(() => [])), words, RECENT.test(what))
      let place = live && { app: live.app, window: live.window, label: live.window, ...(live.path ? { path: live.path } : {}) }
      const found = place ? null : await call('gnomon_semantic_search', { query: what, limit: 8 })
      const hits = Array.isArray(found?.value) ? found.value.filter((h) => h?.refType === 'moment' && typeof h.refId === 'string') : []
      for (const hit of place ? [] : hits.slice(0, 4)) {
        const detail = await call('gnomon_moment_detail', { momentId: hit.refId })
        if ((place = placeOf(detail?.value, words, getState()))) break
      }
      if (!place) return end('not-found', `I could not find ${what} in what I have seen you work on. Say so in one sentence.`)
      if (place.private) return end('private', 'That is in a private app, so I do not open it. Say so in one sentence, and do not look for it anywhere else.')
      const { app } = place
      // The title as the app shows it once saved: TextEdit adds " \u2014 Edited" while there are changes, and a raise finds a part of a title.
      const name = String(place.window ?? '').replace(/\s+[\u2014-]\s+Edited$/, '').slice(0, 120)
      const raise = place.url ? { app, url: place.url } : name ? { app, window: name, action: 'raise' } : { app }
      // The newest look says the window is not open: no raise, which would only fail; it is opened again below.
      const newest = getState()?.marks?.lastLook
      const open = raise.window && newest && !newest.refused ? openNow(lookOf(await readLook(newest.id, { at: newest.at }).catch(() => null)), app, name, newest.at) : null
      let shown = open === false ? { isError: true, error: { message: 'no-such-window' } } : await call('screen_act', { ...raise, goal: 'pull it up', because: `Bring up ${place.label.slice(0, 60)}` })
      // Not open any more: by its path when the record has one (the Mac's open, through the gate), else from the app's recent list.
      const reopened = Boolean(shown?.isError && name && /no-such-window|not-running|no window/i.test(textOf(shown)))
      if (reopened) {
        const shell = place.path && !oneOf(BROWSERS, app) && (tools.schemas?.(exec?.agent) ?? []).some((t) => t.name === 'gnomon_run_shell')
        const opened = shell ? await call('gnomon_run_shell', { command: `open -a ${quote(app)} ${quote(place.path)}` }) : null
        if (opened && !opened.isError && opened.value?.exitCode === 0) {
          await call('gnomon_await', { app, window: name, seconds: 8 })
          shown = await call('screen_look', { app, window: name })
        } else if (opened) shown = opened.isError ? opened : { isError: true, error: { message: opened.value?.refused ?? `open ended with exit code ${opened.value?.exitCode}` } }
        else if (oneOf(BROWSERS, app)) shown = await call('screen_act', { app, tab: name, goal: 'pull it up', because: `Show the tab ${name.slice(0, 60)}` })
        else shown = await call('screen_act', { app, steps: [{ app }, { app, action: 'pick-menu', value: `File > Open Recent > ${name}` }], goal: 'pull it up', because: `Open ${name.slice(0, 60)} again` })
        // Run 217 T13: the menu step was refused (not-found) after the app came up, the steps' answer is no error, and "now in front" was said of a closed document.
        const stopped = /^\d+\. .*: refused[^\n]*/m.exec(shown?.isError ? '' : textOf(shown))
        if (stopped) shown = { isError: true, error: { message: stopped[0].replace(/^\d+\. /, '') } }
      }
      if (shown?.isError) return end('refused', `I found ${what} (${place.label} in ${app}) but could not bring it up: ${firstLine(textOf(shown))}. Say that in one sentence.`, { app })
      const last = getState()?.marks?.lastLook
      const look = last && !last.refused && String(last.app).toLowerCase() === app.toLowerCase() ? lookOf(await readLook(last.id, { at: last.at }).catch(() => null)) : null
      const ring = look ? ringOf(look, place, words, reopened) : null
      const marked = ring ? await call('screen_mark', { ref: `${ring.ref}@${tagOf(look)}` }) : null
      const mark = marked && !marked.isError ? /\((mark-[0-9a-f]{8})\)/.exec(textOf(marked))?.[1] : undefined
      // Run 167: "the line you changed is ringed" for a ring on the body. The answer names what is on screen and says only what was ringed.
      // Run 173: the right document came up, and the model then opened the one an earlier ask had named. The result names
      // the thing first and says it is the answer to the newest message.
      return end('shown', `${name || place.label} in ${app} is what the owner's newest message asks for, now in front: answer about it alone and open nothing else, whatever was named earlier in the chat. Say exactly this, nothing more and no other claim about what is ringed: "Here is ${name || place.label} in ${app}${mark ? `; ${ring.said}` : ''}."`, { app, ...(mark ? { mark } : {}) })
    },
  })
}
