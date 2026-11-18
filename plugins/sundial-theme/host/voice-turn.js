// Plan 15 step 3: a spoken turn's reply, said aloud by Sundial.app. The first two sentences go to the app one by one
// as they stream; a tool that still runs 1.5 s after the nod gets one holding line. The owner's stop
// (`voice:interrupted`, from the app) drops the rest. All of the reply is still shown in the thread.
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { taskOf } from '@sundial/helpers/task-of.js'
import { isRigSession } from '@sundial/kernel/read/rig-session.js'
import { pickLine, refusalLine } from '@sundial/kernel/voice-lines.js'

// What gets SAID is the reply's first paragraph, not a fixed count of sentences (2026-11-13). Benched in
// lab/chat/readback.mjs over 12 cases × 2, judged by Haiku against four calibrated cases. Overall quality ties
// with the old two-sentence cut at 22/24 (the bench's ceiling); the paragraph says more of the reply, p50 41
// words against 17, and held 8/8 across both runs on the replies that ought to be summarised, where the old
// rule scored 3/8 then 6/8. A third candidate, a Jev judge picking all / summary / elsewhere per reply, scored
// 20/24 while answering "all" for 20 of 24 replies, so it decided little and cost another 158 ms: not built.
export const MAX_SPOKEN = 6
export const HOLD_MS = 1500
const TURN_MS = 120_000

/** The complete sentences at the front of `text`, and what is left. Code, list marks and links are not said. */
export function sentencesOf(text, lang) {
  // A sentence is done once a space follows its end mark; the last part is still being written. Two messages
  // streamed back to back can arrive glued ("Checking now.Claude is up"), so a capital right after one also ends it.
  const parts = text.split(/(?<=[.!?])(?:\s+|(?=[A-Z][a-z]))/)
  const rest = parts.pop() ?? ''
  return { done: parts.map((part) => speakable(part, lang)).filter(Boolean), rest }
}

// Said as a person says them (2026-11-13): the voice read "200°C" as "200 C" and "500g" as "500 g".
const UNITS = {
  en: { '°C': 'degrees', '°F': 'degrees Fahrenheit', '°': 'degrees', kg: 'kilograms', mg: 'milligrams', ml: 'milliliters', km: 'kilometers', cm: 'centimeters', mm: 'millimeters', min: 'minutes', g: 'grams', l: 'liters', h: 'hours', '%': 'percent', k: 'thousand' },
  nl: { '°C': 'graden', '°F': 'graden Fahrenheit', '°': 'graden', kg: 'kilo', mg: 'milligram', ml: 'milliliter', km: 'kilometer', cm: 'centimeter', mm: 'millimeter', min: 'minuten', g: 'gram', l: 'liter', h: 'uur', '%': 'procent', k: 'duizend' },
}
const WORDS = {
  en: { to: 'to', about: 'about', and: 'and', euro: 'euros', 'e.g.': 'for example', 'i.e.': 'that is', 'etc.': 'and so on', 'vs.': 'versus' },
  nl: { to: 'tot', about: 'ongeveer', and: 'en', euro: 'euro', 'bijv.': 'bijvoorbeeld', 'e.g.': 'bijvoorbeeld', 'etc.': 'enzovoort', 'vs.': 'tegen' },
}
const UNIT = /(\d)\s?(°C|°F|°|kg|mg|ml|km|cm|mm|min|g|l|h|%|k)(?![A-Za-z])/g

/** A sentence as it can be said: no markdown, code, links, list marks, symbols or unit letters. Empty when nothing sayable is left. */
export function speakable(sentence, lang) {
  const nl = /^(nl|dutch)/i.test(lang ?? '')
  const unit = UNITS[nl ? 'nl' : 'en']
  const word = WORDS[nl ? 'nl' : 'en']
  return sentence
    .replace(/```[\s\S]*?```|`[^`]*`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_#>|]/g, '')
    .replace(/€\s?(\d[\d.,]*)/g, `$1 ${word.euro}`)
    .replace(/(\d)\s?[-–]\s?(\d)/g, `$1 ${word.to} $2`)
    .replace(UNIT, (_, n, u) => `${n} ${unit[u]}`)
    .replace(/~\s?(\d)/g, `${word.about} $1`)
    .replace(/\s&\s/g, ` ${word.and} `)
    .replace(/(^|[\s(])(e\.g\.|i\.e\.|etc\.|vs\.|bijv\.)/gi, (_, pre, w) => `${pre}${word[w.toLowerCase()] ?? w}`)
    .replace(/\s*[—–(]\s*/g, ', ')
    .replace(/\s*\)/g, ',')
    .replace(/["“”„]/g, '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The part of a reply that is said aloud: everything up to the first blank line, list mark, heading or code
 * fence. `ended` is true once that boundary has arrived, so the stream knows the spoken part is complete and
 * nothing after it is said. A reply that is one paragraph is said whole; a report says its opening and shows
 * the rest.
 */
export function spokenPart(text) {
  const at = text.search(/\n\s*\n|\n\s*(?:[-*•]|\d+[.)])\s|\n\s*#{1,6}\s|```/)
  return at === -1 ? { part: text, ended: false } : { part: text.slice(0, at), ended: true }
}

// What a turn already sent is folded (Set 2 R3): `voice:turn` opens it, every line sent is a `voice:line` row with the
// turn's session, `turnAt` and seq, and `state.voice.said` holds them. After a restart a reply in that chat goes on past
// them (`revive`) and never says one again. `turns` keeps only what no row can hold: the text still streaming (the
// unsaid tail), the held refusal, and the two timers.
export function mountVoice(ctx, { now = Date.now } = {}) {
  const turns = new Map()
  const stopped = (turn) => {
    const at = ctx.gnomonKernel.getState?.()?.voice?.interruptedAt
    return typeof at === 'string' && at >= turn.atIso
  }
  /** One line to the app, and its row: `row` names a holding or step line; without it the line is the reply's own. */
  const send = (turn, text, extra = {}, row = { reply: true }) => {
    const seq = turn.seq++
    ctx.gnomonKernel.appChannel.send({ type: 'speak', text, sound: null, mode: 'reply', seq, lang: turn.lang, voice: turn.voice, turnAt: turn.atIso, ...extra })
    if (text) turn.told.add(text)
    void Promise.resolve(ctx.gnomonKernel.appendSignal('voice:line', { line: text, ...row, session: turn.session, turnAt: turn.atIso, seq, ...(extra.last ? { last: true } : {}) })).catch(() => {})
  }
  const make = (session, lang, at, ms = TURN_MS) => {
    const turn = { session, at, atIso: new Date(at).toISOString(), lang: typeof lang === 'string' ? lang : null, voice: loadSundialConfig().voice, buffer: '', said: 0, steps: 0, lastStep: null, refused: null, told: new Set(), seq: 0, ended: false, lined: false, hold: null, timer: null }
    turn.timer = setTimeout(() => end(session), ms)
    turns.set(session, turn)
    return turn
  }
  /** After a restart: the spoken turn the fold holds open in this chat, rebuilt past the lines it already sent. */
  const revive = (id) => {
    const state = ctx.gnomonKernel.getState?.()
    const said = state?.voice?.said
    const at = Date.parse(said?.at ?? '')
    if (!said || said.session !== id || said.ended || !(now() - at < TURN_MS)) return undefined
    // A newer task in this chat: that turn is over. Interrupted: nothing more is said.
    if (Date.parse(taskOf(state, id)?.at ?? '') - at > 5_000) return undefined
    if (typeof state?.voice?.interruptedAt === 'string' && state.voice.interruptedAt >= said.at) return undefined
    const turn = make(id, said.lang, at, TURN_MS - (now() - at))
    // Every line sent counts against the cap, so a restart never says more than one turn would.
    Object.assign(turn, { seq: said.seq, said: said.lines.length, lined: true })
    for (const line of said.lines) turn.told.add(line)
    return turn
  }
  const end = (id) => {
    const turn = turns.get(id)
    if (!turn) return
    clearTimeout(turn.timer)
    clearTimeout(turn.hold)
    turns.delete(id)
    // A reply that ended mid-sentence, or with no end mark at all, still says its first words.
    if (stopped(turn) || turn.ended || turn.said >= MAX_SPOKEN) return
    // Still sent when there is nothing left to say: the empty line is how the app learns the turn is over.
    const tail = speakable(spokenPart(turn.buffer).part, turn.lang)
    send(turn, turn.told.has(tail) ? '' : tail, { last: true })
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const chunk = frame?.chunk
    if (frame?.type !== 'chunk' || chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    const turn = turns.get(agent?.session?.id) ?? revive(agent?.session?.id)
    if (!turn) return
    turn.buffer += chunk.text
    if (turn.ended) return
    const { part, ended } = spokenPart(turn.buffer)
    const { done, rest } = sentencesOf(part, turn.lang)
    // Once the paragraph has ended its tail is the last thing said, so it is spoken here rather than kept.
    // A line this turn already sent (before a restart, too) is never sent again.
    const lines = (ended ? [...done, speakable(rest, turn.lang)].filter(Boolean) : done).filter((line) => !turn.told.has(line))
    turn.buffer = ended ? '' : rest
    turn.ended = ended
    // Everything in the paragraph was said already: the app still learns the turn is over.
    if (ended && lines.length === 0 && turn.said > 0 && !stopped(turn)) send(turn, '', { last: true })
    for (const [i, sentence] of lines.entries()) {
      if (turn.said >= MAX_SPOKEN || stopped(turn)) break
      turn.said += 1
      send(turn, sentence, turn.said === MAX_SPOKEN || (ended && i === lines.length - 1) ? { last: true } : {})
    }
  })

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    const turn = turns.get(id) ?? (event?.type === 'turn/end' || event?.type === 'tool/call' ? revive(id) : undefined)
    if (!turn) return
    if (event?.type === 'turn/end') return end(id)
    if (event?.type !== 'tool/call' || turn.said > 0 || turn.lined) return
    const tool = typeof event.data?.name === 'string' ? event.data.name : ''
    turn.lined = true
    turn.hold = setTimeout(() => {
      if (turn.said > 0 || turn.steps > 0 || stopped(turn) || !turns.has(id)) return
      const line = pickLine(tool, ctx.gnomonKernel.getState?.()?.voice?.recentLines ?? [])
      send(turn, line, { holding: true }, { tool })
    }, Math.max(0, turn.at + HOLD_MS - now()))
  })

  // NEXT 3.1: a screen step says its own line as it starts (screen-tools.js `stepLine`), in a spoken turn only, in the
  // reply's order. Never the line just said, never past the reply's spoken part, and not in the rig's sessions unless
  // config `voice.rigLines` asks for it: a bench run stays quiet.
  // Set 2 R1 item 5: a refused step (`refused`) is held, and said with the next step's words (`next`) as one line,
  // "Sort By not found. Open the View menu.", never the same line twice in a turn. Its `voice:line` names the
  // refused step (`refused`), so voice-stats can count refusals followed by a line before the next act.
  ctx.on('gnomon/step-line', ({ session, stepId, line, next, refused } = {}) => {
    const turn = turns.get(session) ?? revive(session)
    const state = ctx.gnomonKernel.getState?.()
    if (!turn || (isRigSession(state, session) && turn.voice?.rigLines !== true)) return
    if (refused) return void (turn.refused = { ...refused, stepId: String(stepId ?? '') })
    const after = turn.refused && next ? speakable(refusalLine(turn.refused, String(next)) ?? '', turn.lang) : ''
    const of = after && !turn.told.has(after) ? turn.refused.stepId : null
    if (after) turn.refused = null
    const text = of ? after : speakable(String(line ?? ''), turn.lang)
    if (!text || turn.ended || turn.said >= MAX_SPOKEN || turn.steps >= MAX_SPOKEN || stopped(turn) || turn.lastStep === text || state?.voice?.recentLines?.at(-1) === text) return
    turn.steps += 1
    turn.lastStep = text
    send(turn, text, { holding: true, stepId: String(stepId ?? '') }, { tool: 'screen_act', stepId: String(stepId ?? ''), ...(of ? { refused: of } : {}) })
  })

  return {
    /** A spoken turn starts now (the key was let go just before): its reply is said. */
    begin(sessionId, lang) {
      end(sessionId)
      if (ctx.gnomonKernel.getState?.()?.config?.experiments?.holdToTalk === false) return
      const turn = make(sessionId, lang, now())
      void Promise.resolve(ctx.gnomonKernel.appendSignal('voice:turn', { session: sessionId, turnAt: turn.atIso, lang: turn.lang })).catch(() => {})
    },
  }
}
