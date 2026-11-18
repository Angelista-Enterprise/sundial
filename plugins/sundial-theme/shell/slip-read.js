// What the slip reads (overlay.js draws it): pure functions over what app.js renders in the hidden conversation, the
// approval that waits, and the times the page saw. One reader per fact: askOf for an ask, doingOf for the step rows,
// slipOf for the state, readoutOf and lapsOf for the readout slot and the last steps. No DOM of its own.
import { argsText, elapsed, resultGist, toolLine } from './tool-line.js'

const json = (v) => {
  try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v }
}

/** The kind word an ask's head carries, per final (gate.js `finalAsk`'s tag). */
const KINDS = { send: 'Send', submit: 'Submit', delete: 'Delete', discard: 'Discard', pay: 'Pay', post: 'Post', update: 'Update', overwrite: 'Replace', archive: 'Archive', leave: 'Leave', block: 'Block', share: 'Share', transfer: 'Transfer', merge: 'Merge', answer: 'Answer', 'final-unknown': 'Return key' }
/** "writes "a"; reads "b"" as a clause: "writes "a" and reads "b"". */
const clause = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`)
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/**
 * What an approval is about: the thing to ring (a ref from a look, or a name; in `target` or flat) and the line
 * the owner reads. The gate's own line (what will be pressed, the value) comes first; the model's words are `said`.
 * `kind` is the head's word (Send, Shell command), `final` whether the gate called it a final.
 */
export function askOf(args, tool, reason) {
  const call = json(args) ?? {}
  // Through gnomon_call the act is one level in: {name, args}.
  const a = typeof call.name === 'string' && call.args !== undefined ? json(call.args) ?? {} : call
  // Several steps in one call: the ring goes on the first, in the call's app.
  const [first] = Array.isArray(json(a.steps)) ? json(a.steps) : []
  const at = first && typeof first === 'object' ? { app: a.app, window: a.window, ...first } : a
  const flat = Object.fromEntries(['app', 'window', 'role', 'label', 'text', 'ref'].filter((k) => typeof at[k] === 'string' && at[k] !== '').map((k) => [k, at[k]]))
  const given = json(at.target)
  const target = { ...flat, ...(given && typeof given === 'object' ? given : {}) }
  const ring = target.app || target.ref ? target : null
  const said = typeof a.because === 'string' ? a.because.trim() : ''
  const text = typeof reason === 'string' ? reason.trim() : ''
  // A final (gate.js finalAsk): its kind and target sentence is the line; the steps and what follows ` · ` (To, Path, Command) under it.
  const final = /^Gnomon: this (.*?), so it asks you first\.\s*(.*?)\s*(?:· final: ([a-z-]+))?$/.exec(text)
  if (final) {
    const detail = final[2].split(' · ').map((s) => s.trim()).filter(Boolean).join('\n')
    return { target: ring, line: `This ${final[1]}.`, kind: KINDS[final[3]] ?? 'Final step', final: true, ...(detail ? { detail } : {}), ...(said ? { said } : {}) }
  }
  // A plain ask behind the preset (gate.js decideAction; index.js adds what a shell command touches and the command itself).
  const behind = /^Gnomon: (?:'([\w-]+)'|(a shell command)|(.+? → \S+)) runs behind your approval \([^)]*\)\.\s*(.*)$/.exec(text)
  if (behind) {
    const parts = behind[4].replace(/^·\s*/, '').split(' · ').map((s) => s.trim()).filter(Boolean)
    const touches = parts.find((p) => p.startsWith('Touches: '))
    const command = parts.find((p) => p.startsWith('Command: '))
    const shell = behind[2] !== undefined || /shell/.test(behind[1] ?? '')
    const on = ring?.label ? ` on "${ring.label}"${ring.app ? ` in ${ring.app}` : ''}` : ring?.app ? ` in ${ring.app}` : ''
    const line = !shell
      ? `This uses ${behind[1] ?? behind[3]}${on}.`
      : touches ? `This runs a shell command that ${clause(touches.slice(9).split('; '))}.` : command ? `This runs a shell command: ${clip(command.slice(9), 90)}` : 'This runs a shell command.'
    const detail = parts.filter((p) => p !== touches).join('\n')
    return { target: ring, line: /[.…]$/.test(line) ? line : `${line}.`, kind: shell ? 'Shell command' : behind[1] ?? 'Tool', ...(detail ? { detail } : {}), ...(said && said !== line ? { said } : {}) }
  }
  // Every other reason the gate gives starts with "Gnomon:"; a plan's line does not. The model's words before a gate line that names no act.
  const made = text !== '' && !text.startsWith('Gnomon:') ? text : ''
  const gate = text.startsWith('Gnomon:') ? text.slice(7).trim().replace(/^./, (c) => c.toUpperCase()) : ''
  // A dsh-native approval or a gate line that names no act: the call's own arguments go under the line, so the card never
  // shows only the model's claim about what it will do.
  const detail = argRows(a)
  return { target: ring, line: made || said || gate || `Gnomon wants to use ${tool}.`, kind: 'Asks first', ...(detail ? { detail } : {}), ...(made && said && said !== made ? { said } : {}) }
}

/** A call's arguments as detail rows ("Command: ls"), the model's `because` left out (it is the line or the reason); bounded. */
const argRows = (args) => {
  const text = argsText(args && typeof args === 'object' ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'because')) : args)
  if (text === null) return ''
  const parsed = json(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `Arguments: ${clip(text.replace(/\s+/g, ' '), 200)}`
  return Object.entries(parsed).slice(0, 6).map(([k, v]) => `${k.replace(/^./, (c) => c.toUpperCase()).replace(/_/g, ' ').slice(0, 15)}: ${clip(typeof v === 'string' ? v : JSON.stringify(v), 200)}`).join('\n')
}

/** An ask's detail lines as rows: `To: a` is a named row, a step line ("Press "Send" in Zen") a row named Step. */
export const detailRows = (detail) => String(detail ?? '').split('\n').filter(Boolean).map((l) => /^([A-Z][\w ]{0,14}): (.+)$/.exec(l)?.slice(1) ?? ['Step', l])

/**
 * What the slip says, and what its edge shows, from what the conversation shows now. An answer is
 * `full`: the slip holds all of it, as the app rendered it, and scrolls. `state` names the row of the state table.
 * Edge modes: still, listen (the owner's voice, ink), think (an ochre head runs), speak (Gnomon, ochre),
 * one (one ochre mark: waits), steps (a guide: done parts in ink, the current one in ochre).
 */
/** The slip's line above the row while the owner's hand holds Gnomon's next step on the screen (sundial-actions/owner-hand.js holds it). */
export const HAND_LINE = 'Waiting: your hands are on the keys.'

/** Set 4 R2: what a withdrawn turn says (the host's watchdog, api-sessions.js `DROPPED_LINE`); its older words read the same. */
export const DROPPED_LINE = 'I dropped that, ask again.'
const DROPPED = /^I dropped that\b|\bwithdrawn\b/i

/**
 * Set 4 R2: why a turn ended without an answer, from one reader: the owner's stop names its step and app; the route's own
 * line (an `llm:` mark: the backup it tried, by name, and whether it answered) is said as it is; a withdrawn turn says
 * DROPPED_LINE; any other error line (`fail`, as app.js draws it) is said as it is.
 */
export function endOf({ stopped = null, model = '', fail = '' } = {}) {
  if (stopped) return `Stopped${stopped.steps ? ` at step ${stopped.steps}${stopped.app ? ` in ${stopped.app}` : ''}` : ''}.`
  return DROPPED.test(fail) ? DROPPED_LINE : model || fail
}

/** Set 4 R2: the shelf's line ("Waiting for the build, I will knock.") when the newest call put its wait on the shelf (await-tool.js), else ''. */
export const shelfOf = (row) => /^On the shelf: (.+)$/m.exec(String(row?._result ?? ''))?.[1].trim() ?? ''

/** Set 4 R2: "what did you do today", asked of the slip: answered by the day's line, one read, no turn. */
export const DAY_ASK = /^\s*(so\s+)?what\s+(did|have)\s+you\s+(do|done|been\s+doing)(\s+today)?\s*\??\s*$/i
export const DAY_NONE = 'Gnomon did nothing on screen today, and asked nothing.'
/** After 17:00 by the owner's own clock, a summon's still line is the day's. */
export const evening = (date) => date.getHours() >= 17

/** Set 4 R2: the side question's answer as its frames come (`text`, `approval`, `error`, `done`); `asideText` says it in one line. */
export function foldAside(aside, frame) {
  if (frame?.type === 'text' && typeof frame.delta === 'string') return { ...aside, a: `${aside.a}${frame.delta}`.replace(/^\s+/, '') }
  if (frame?.type === 'approval') return { ...aside, asks: true }
  if (frame?.type === 'error') return { ...aside, a: aside.a || String(frame.message ?? '') }
  return frame?.type === 'done' ? { ...aside, done: true } : aside
}
export const asideText = (aside) => aside.a.replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim() || (aside.asks ? 'It asks first: open its thread (⌥L) to answer.' : aside.done ? 'No answer came.' : 'Working on it…')

/** A turn's stream (`data: <json>` frames, a blank line apart) to `onFrame`, and a `done` when it ends. */
export async function readFrames(response, onFrame) {
  const reader = response?.body?.getReader?.()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = reader ? await reader.read().catch(() => ({ done: true })) : { done: true }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const line of parts.map((p) => p.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean)) {
      try { onFrame(JSON.parse(line.slice(6))) } catch {}
    }
  }
  onFrame({ type: 'done' })
}

/**
 * Set 4 R2: `aside`, a second question running in a side thread, joins the head while the task runs ("Renaming 3 files · and: ...");
 * `shelf`, the newest call put its wait on the shelf: the slip is still, with that line, while the turn says its last words.
 */
export function slipOf({ listening = false, running = false, said = '', reply = '', doing = '', steps = 0, app = '', ms = 0, ask = null, guide = null, note = '', model = '', stopped = null, offer = null, hand = false, aside = '', shelf = '', fail = '' } = {}) {
  if (listening) return { state: 'listen', scale: 'listen', line: 'Listening. Let go to send.', tone: 'small' }
  if (ask) return ask.ringed ? { state: 'ringed', scale: 'one', line: 'Waits for your yes.', tone: 'small' } : { state: 'ask', scale: 'one', line: ask.line, tone: '', ask: true, ...(ask.detail ? { detail: ask.detail } : {}), ...(ask.said ? { said: ask.said } : {}) }
  if (guide) return { state: 'guide', scale: 'steps', line: `Step ${guide.step}${guide.of ? ` of ${guide.of}` : ''}. The ring moves when you do it.`, tone: 'small', guide: true }
  if (shelf) return { state: 'still', scale: 'still', line: shelf, tone: 'small', shelf: true }
  if (running && reply === '') {
    // `hand`: the owner's hand holds the next screen step. The line stays the step's; HAND_LINE goes above the row (overlay.js), never over the field.
    const held = hand ? { hand: true } : {}
    const and = aside ? ` · and: ${aside}` : ''
    if (doing && steps > 0) return { state: 'doing', scale: 'think', line: `${doing}${and}`, tone: 'small', doing: { line: doing, steps, app, ms }, ...held }
    return doing ? { state: 'think', scale: 'think', line: `${doing}${and}`, tone: 'small', ...held } : { state: 'think', scale: 'think', line: said ? `“${said}”${and}` : '', tone: 'heard', ...held }
  }
  if (reply !== '') return { state: 'answer', scale: running ? 'speak' : 'still', line: reply, tone: '', full: true }
  if (stopped) return { state: 'stopped', scale: 'still', line: endOf({ stopped }), tone: 'small' }
  // An offer's line is its notice's own words when the page has them: the button above it is for that.
  const end = endOf({ model, fail })
  if (offer) return { state: 'offer', scale: 'still', line: offer.line || note || end, tone: 'small', offer: true }
  return { state: !note && end ? 'stopped' : 'still', scale: 'still', line: note || end, tone: 'small' }
}

/**
 * What the turn is doing, from its tool rows and `llm:` log lines: the model's line when it is newest, else the newest call's step line (app.js keeps the `step` frame on its row: the words
 * screen-tools.js `stepLine` gives the voice), else its verb and argument; the steps taken so far and the app of the newest.
 */
export function doingOf(rows) {
  const tool = rows.at(-1)
  // Set 2 R4: the model's own line ("trying the backup", an `llm:` log line) counts as the newest thing done, and stays once the turn ends.
  const model = tool?.matches('.log-line') ? tool.querySelector('.log-line-label')?.textContent ?? '' : ''
  const doing = model || (tool ? tool.dataset.step || [tool.querySelector('.tool-verb')?.textContent, tool.querySelector('.tool-arg')?.textContent].filter(Boolean).join(' · ') : '')
  const stepped = rows.filter((r) => r.dataset.steps)
  return { doing, model, steps: stepped.reduce((n, r) => n + Number(r.dataset.steps), 0), app: askOf(stepped.at(-1)?._args).target?.app ?? '' }
}

/**
 * The ask the slip shows: the newest unsettled card in the newest turn, while that turn runs on and the card can still be
 * answered (a press here, a voice yes or the rig's yes-clicker turns its buttons off at once; app.js marks the close from
 * anywhere `data-settled`; a card the host knows is dead after a restart has no `_ask`). It never outlives its turn.
 */
export function askCard(turn) {
  if (!turn || turn.hasAttribute('data-ended')) return null
  return [...turn.querySelectorAll('.approval:not([data-settled])')].filter((c) => c._ask && [...c.querySelectorAll('.approval-acts button')].some((b) => !b.disabled)).at(-1) ?? null
}

/** A message typed while a turn runs waits for its end; a second one joins it on a line of its own. */
export const queued = (waiting, text) => [waiting, String(text ?? '').trim()].filter(Boolean).join('\n')

/**
 * While a turn runs: Stop, and after 20 s, plainly, that it is still at it (its step and app) and for how long. A message that waits says so.
 * `thinking` (no step yet): after a minute, how many minutes, and the way out (run202 T03 sat at "thinking 5:04" with nothing else).
 */
export function runOf({ running = false, ms = 0, waits = '', steps = 0, app = '', thinking = false } = {}) {
  const at = steps ? `: step ${steps}${app ? ` in ${app}` : ''}` : ''
  const still = !running || ms < 20_000 ? '' : thinking && !steps ? (ms >= 60_000 ? `Still thinking, ${Math.floor(ms / 60_000)} min, no step yet. ⌥. stops it.` : '') : `Still working${at}, ${elapsed(ms)}.`
  return { stop: running, still, waits: waits ? `Sends when this is done: “${waits.replace(/\s+/g, ' ')}”` : '' }
}

/**
 * The place chip's words, short enough for the chip (run200 T01 showed "Add Finder: Testbox-rena…"): the whole place when it fits,
 * else the window's name alone, else cut at a word. `max` is in characters; `lead` is "Add " on an offer, nothing once attached.
 */
export function chipText(place, { lead = 'Add ', tail = '', max = 24 } = {}) {
  const fit = (s) => `${lead}${s}${tail}`.length <= max
  if (fit(place)) return `${lead}${place}${tail}`
  const name = place.includes(': ') ? place.slice(place.indexOf(': ') + 2) : place
  if (fit(name)) return `${lead}${name}${tail}`
  const room = Math.max(4, max - lead.length - tail.length - 1)
  const cut = name.slice(0, room)
  // A cut that ends on a word's end keeps that word; else back to the last break.
  const word = /\s/.test(name[room] ?? ' ') ? cut.trimEnd() : cut.replace(/[\s,.;:/_-]+\S*$/, '')
  return `${lead}${word.length >= room / 2 ? word : cut}…${tail}`
}

/** The edge's ticks, `[height, class]`, 6 px apart. */
export function ticks(mode, n, step = 1, of = 1) {
  const wave = (i, s) => Math.abs(Math.sin(i * 0.9 + s) * Math.sin(i * 0.23 + s * 2))
  const env = (i) => Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 0.6)
  return Array.from({ length: n }, (_, i) => {
    if (mode === 'listen') return [3 + Math.round(wave(i, 1.3) * 11 * env(i)), 'you']
    if (mode === 'speak') return [3 + Math.round(wave(i, 4.1) * 11 * env(i)), 'g']
    if (mode === 'steps') {
      const part = Math.floor((i * of) / n) + 1
      const edge = i === 0 || Math.floor(((i - 1) * of) / n) + 1 !== part
      return [edge ? 13 : part === step ? 7 : 4, part < step ? 'you' : part === step ? 'g' : '']
    }
    if (mode === 'one' && i === Math.floor(n / 2)) return [13, 'g']
    return [i % 5 === 0 ? 7 : 4, '']
  })
}

const secs = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : elapsed(ms))
const stepOf = (s) => [s.action, s.role, s.label ?? s.text ?? s.ref, s.value === undefined ? null : s.action === 'key' ? s.value : `"${String(s.value).slice(0, 28)}"`].filter(Boolean).join(' ')
/** What came back, in a line: a JSON-quoted text unwrapped, a look's "Read off the screen" header skipped. */
const backOf = (result, failed) => {
  let text = String(result ?? '')
  try { if (text.startsWith('"')) text = JSON.parse(text) } catch {}
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !/^Read off the screen/.test(l)) ?? ''
  return resultGist(line, failed)
}
/** The error a call came back with, when gnomon_call wrapped a failed tool as `{ error }`. */
const errorOf = (result) => { try { const v = JSON.parse(String(result ?? '')); return typeof v?.error === 'string' ? v.error : null } catch { return null } }
const argsOf = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? {} } catch { return {} } }

/**
 * The clock of one turn's calls (app.js: `_t0`, `_ms`, `_result`): per call the model's time before it and its own time
 * (running: until `now`); `last` is when the newest call ended. Times are performance.now() values from `t0`, the turn's start.
 */
export function clockOf(rows, t0, now) {
  const laps = []
  const last = rows.reduce((at, row) => {
    const done = row._result !== undefined
    const start = row._t0 ?? at
    const ms = done ? row._ms ?? 0 : now - start
    laps.push({ think: Math.max(0, start - at), ms, done, timed: row._t0 != null })
    return start + ms
  }, t0)
  return { laps, last }
}

/**
 * The trace of one turn, from its tool rows (app.js: `_args`, `_result`, `_t0`, `_ms`, `data-failed`): a head line,
 * then per call the model's time before it, what it did, how long it took and what came back; a thinking line last
 * while the model is at it. `t0` is when the turn began; times are performance.now() values.
 */
export function traceOf(rows, t0, now, running, asking = false) {
  const { laps, last } = clockOf(rows, t0, now)
  const items = rows.map((row, i) => {
    const outer = row.querySelector?.('.tool-main')?.title ?? ''
    const name = outer === 'gnomon_call' ? row._args?.name ?? outer : outer
    const args = outer === 'gnomon_call' ? argsOf(row._args?.args) : row._args ?? {}
    const { done, think, ms } = laps[i]
    const inner = done ? errorOf(row._result) : null
    const failed = row.hasAttribute?.('data-failed') || /^Error:/.test(String(row._result ?? '')) || inner !== null
    const { verb, detail } = toolLine(name, args)
    const steps = Array.isArray(args.steps) ? args.steps.map(stepOf).join(' → ') : name.startsWith('screen_') ? stepOf(args) : ''
    return {
      state: !done ? 'run' : failed ? 'fail' : 'ok',
      title: [verb, detail].filter(Boolean).join(' · '),
      time: row._t0 == null ? '' : secs(ms),
      sub: [row._t0 == null ? null : `model ${secs(think)}`, name, steps].filter(Boolean).join(' · '),
      why: inner !== null ? resultGist(inner, true) : done ? backOf(row._result, failed) : null,
      failed,
    }
  })
  // While an ask waits, the turn is not thinking: it waits for the owner (run201 T10 said "Thinking 2m 50s" beside the ask).
  if (running && items.every((i) => i.state !== 'run')) items.push(asking ? { state: 'run', title: 'Waiting for your yes', time: secs(now - last), sub: 'the next call asks first' } : { state: 'run', title: 'Thinking', time: secs(now - last), sub: 'the model decides the next step' })
  const n = rows.length
  const bad = items.filter((i) => i.failed).length
  if (rows.every((row) => row._t0 == null)) return [`${n} ${n === 1 ? 'call' : 'calls'}${bad ? ` · ${bad} failed` : ''}`, ...items]
  const model = laps.reduce((s, l) => s + l.think, 0) + (running && items.at(-1)?.title === 'Thinking' ? now - last : 0)
  return [`${n} ${n === 1 ? 'call' : 'calls'} · model ${secs(model)} · tools ${secs(laps.reduce((s, l) => s + l.ms, 0))}${bad ? ` · ${bad} failed` : ''}`, ...items]
}

/** A duration as the readout says it: "4.0 s" under ten seconds, "38 s" under a minute, "1:04" past it. */
export const dur = (ms) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : clock(ms))
/** Elapsed on a wall clock: "0:24". */
export const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const hhmm = (at) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The last steps with their times, newest last: per call its number (the turn's step count once that call stepped,
 * as the eye's tag and the readout count), its words (the voice's step line, else the call's verb and argument), the
 * model's time before it and its own (running: none yet). A model that decides after the newest call is one more line.
 */
export function lapsOf(rows, t0, now, running, keep = 3) {
  const { laps, last } = clockOf(rows, t0, now)
  let n = 0
  const out = rows.map((row, i) => {
    const stepped = Number(row.dataset?.steps ?? 0)
    n += stepped
    const title = row.dataset?.step || [row.querySelector?.('.tool-verb')?.textContent, row.querySelector?.('.tool-arg')?.textContent].filter(Boolean).join(' · ')
    return { n: stepped ? n : null, title, model: laps[i].timed ? laps[i].think : null, tool: laps[i].done && laps[i].timed ? laps[i].ms : null, now: running && !laps[i].done }
  })
  if (running && out.every((l) => !l.now) && rows.length) out.push({ n: null, title: 'Deciding the next step', model: now - last, tool: null, now: true })
  return out.slice(-keep)
}

/**
 * The readout slot, two lines (`top` over `bottom`), from the state and the times the page saw. `tag`: the step number on the
 * ochre square; `wait`: the top line is Gnomon's (an ask). Nothing when there is nothing true to say.
 */
export function readoutOf(state, { steps = 0, app = '', ms = 0, think = 0, waited = 0, next = null, answeredAt = null, took = 0, model = 0, stoppedAt = null, tool = false } = {}) {
  if (state === 'doing') return { top: `step ${steps}${app ? ` · ${app}` : ''}`, bottom: `${clock(ms)} · model ${dur(think)}`, tag: steps }
  // `tool`: a call runs (a wait, a read, a shell job): the model is not thinking then (run200 T01 said "thinking" through a 16 s wait).
  if (state === 'think') return { top: tool ? 'working' : 'thinking', bottom: clock(ms), tag: null }
  if (state === 'ask' || state === 'ringed') return { top: 'waits for your yes', bottom: [clock(waited), next ? `step ${next}` : null].filter(Boolean).join(' · '), tag: next, wait: true }
  if (state === 'stopped' && stoppedAt) return { top: `stopped ${hhmm(stoppedAt)}`, bottom: `after ${clock(took)}${steps ? ` · ${steps} ${steps === 1 ? 'step' : 'steps'}` : ''}`, tag: null }
  if (answeredAt === null || !['answer', 'still', 'offer'].includes(state)) return null
  const tail = state === 'answer' && model ? `model ${dur(model)}` : steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : ''
  return { top: `answered ${hhmm(answeredAt)}`, bottom: [`in ${dur(took)}`, tail].filter(Boolean).join(' · '), tag: null }
}
