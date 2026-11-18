// A chat stream that goes quiet is cut, sent once more (to the backup route when there is one), and ends with a line.
//
// Run 80 T05 (2026-11-14): a chat stream sent its first token at 5 s, then nothing for 2 min. Runs 247 to 249 (2026-11-17,
// doc 29): four chat calls sent one "\n" at 1 to 3 s and then nothing for 46, 123, 184 and 156 s. The guard here stopped
// watching at the first text block, so that newline switched it off and only the 120 s idle limit (sundial-tools budget.js)
// or a Stop ended them. A blank delta is not an answer: the watch now runs to the stream's end, on the resend too.
//
// Run 250 (doc 30): a whole tool call at 1 s, one character of text, then 89 s and 62 s of text the think-tag strip
// (saidOnly) holds back. The watch saw a chunk every second and never fired; only the 90 s cap ended one. A hidden thought
// is not an answer: the watch (`think` ms) and the slow status count only what the owner is shown, `seen` below.
//
// Named exports only.
import { TOOL_MARKUP, unthought } from '../sundial-tools/answer-only.js'

/** `llm.stallMs` overrides it; 0 is off (the cap too). */
export const STALL_MS = 20000
/** One chat call, the resend included, never runs longer than this. Runs 207 to 249: no openrouter chat call that answered took over 12 s, no tensorx one over 90 s. */
export const CALL_CAP_MS = 90000
/** Chunks with nothing shown (reasoning, text the strip holds) for this long are a stall, as silence for `after` is. */
export const THINK_MS = 30000
export const SILENT_LINE = 'The model did not answer; try again in a minute.'
/** Not in dsh's retryable codes: the turn ends on it instead of sending the same call again. */
export const SILENT_CODE = 'GNOMON_MODEL_SILENT'

/** The part of a text block the owner is shown (saidOnly holds the rest): its thought out, cut at tool-call markup. */
export function visible(text) {
  const clean = unthought(text)
  const at = clean.search(TOOL_MARKUP)
  return at < 0 ? clean : clean.slice(0, at)
}

/** `seen(chunk)`: true when the chunk shows the owner something new, a tool call or text past the strip. Never reasoning. */
export function sight() {
  const texts = new Map()
  return (chunk) => {
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) return true
    if (chunk.type !== 'text-delta') return false
    const b = texts.get(chunk.index) ?? { text: '', shown: 0 }
    texts.set(chunk.index, b)
    b.text += chunk.text
    const n = visible(b.text).trim().length
    return n > b.shown && (b.shown = n) > 0
  }
}

/**
 * Run `start(signal)`; when it sends nothing for `after` ms, or nothing the owner is shown for `think` ms, abort it. When nothing has been shown yet (reasoning, blank or
 * held text alone), run `retry` (default `start`) once: the open blocks are closed and the resend's blocks are numbered after
 * them. A stall after shown text or a tool call, a stall on the resend, or `cap` ms in all: `say(SILENT_LINE, true)` and a finish with
 * SILENT_CODE, so the turn ends with a reason. The caller's signal aborts it all. Each time it fires, `fired({ reason, then, limitMs })`:
 * reason `stall`, `thought` or `cap`, then `resent` or `ended` (doc 31: the thought limit and the cap could not be counted).
 */
export async function* stall(start, { signal, after, think = THINK_MS, retry = start, cap = 0, log = () => {}, say = () => {}, fired = () => {} }) {
  const open = new Map()
  const deadline = cap > 0 ? Date.now() + cap : Infinity
  const said = { real: false, started: false, next: 0 }
  for (const retried of [false, true]) {
    if (retried) log(said.why === 'thought' ? `thought ${think} ms with nothing shown, resent` : said.started ? `stalled after ${after} ms, retried` : `no first byte after ${after} ms, resent`)
    const controller = new AbortController()
    const forward = () => controller.abort(signal.reason)
    if (signal?.aborted) forward()
    else signal?.addEventListener('abort', forward, { once: true })
    const chunks = (retried ? retry : start)(controller.signal)[Symbol.asyncIterator]()
    const offset = said.next
    const seen = sight()
    const clock = { heard: Date.now(), shown: Date.now() }
    let quiet = null
    try {
      for (;;) {
        const now = Date.now()
        const wait = Math.min(after > 0 ? clock.heard + after - now : Infinity, think > 0 ? clock.shown + think - now : Infinity, deadline - now)
        let timer
        const idle = wait < Infinity && new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, wait), null)))
        const step = await (idle ? Promise.race([chunks.next(), idle]).finally(() => clearTimeout(timer)) : chunks.next())
        if (step === null) {
          quiet = Date.now() >= deadline ? 'cap' : after > 0 && Date.now() - clock.heard >= after ? 'stall' : 'thought'
          break
        }
        if (step.done) return
        said.started = true
        const chunk = 'index' in step.value ? { ...step.value, index: step.value.index + offset } : step.value
        if ('index' in chunk) said.next = Math.max(said.next, chunk.index + 1)
        clock.heard = Date.now()
        if (seen(chunk)) (clock.shown = clock.heard), (said.real = true)
        if (chunk.type === 'block-start') open.set(chunk.index, { type: chunk.blockType, text: '' })
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          const block = open.get(chunk.index)
          if (block) block.text += chunk.text
        }
        if (chunk.type === 'block-end') open.delete(chunk.index)
        yield retried && chunk.type === 'finish' ? { ...chunk, stalled: true } : chunk
      }
    } finally {
      controller.abort()
      void chunks.return?.()?.catch?.(() => {})
      signal?.removeEventListener('abort', forward)
    }
    said.why = quiet
    const limitMs = quiet === 'cap' ? cap : quiet === 'thought' ? think : after
    if (quiet !== 'cap' && !retried && !said.real) {
      fired({ reason: quiet, then: 'resent', limitMs })
      // Only reasoning and blank or held text are open here: closed with what was shown, so the resend starts on a clean step.
      for (const [index, block] of open) yield { type: 'block-end', index, block: { type: block.type, text: block.type === 'text' ? visible(block.text) : block.text } }
      open.clear()
      continue
    }
    const what = quiet === 'thought' ? `thought ${think} ms with nothing shown` : `stalled after ${after} ms`
    log(quiet === 'cap' ? `no answer in ${cap} ms, ended` : `${what}${retried ? ' on the resend' : ' after text'}, ended`)
    fired({ reason: quiet, then: 'ended', limitMs })
    say(SILENT_LINE, true)
    yield { type: 'finish', reason: { kind: 'error', failure: { message: SILENT_LINE, code: SILENT_CODE } } }
    return
  }
}

/** Owner, 2026-11-17: a chat call with no word for this long says so on its turn (the slip shows it as the step), again every SLOW_EVERY_MS. */
export const SLOW_STATUS_MS = 8000
const SLOW_EVERY_MS = 4000
export const slowLine = (seconds, hedge = '') => `The model is slow, ${hedge || 'waiting'}… (${seconds} s)`
export const HEDGE_LINES = { backup: 'Trying the backup model…', again: 'Asking the model again…' }

/**
 * A wait the owner can see, so a slow call does not look stuck. `pass(chunks)` passes them on; while no word (`sight`: shown
 * text or a tool call, never a held thought) comes for `after` ms
 * it `say`s slowLine every few seconds, and the next word says how long it took. `hedged(kind)` (the hedge or the stall's resend
 * fired) names the backup in the lines after, and says HEDGE_LINES[kind] at once when a wait is already shown.
 */
export function slowStatus({ say, after = SLOW_STATUS_MS, every = SLOW_EVERY_MS }) {
  const wait = { from: Date.now(), shown: false, hedge: '', timer: undefined }
  const seconds = () => Math.round((Date.now() - wait.from) / 1000)
  const tick = () => {
    wait.shown = true
    say(slowLine(seconds(), wait.hedge), false)
    wait.timer = setTimeout(tick, every)
  }
  const arm = () => (clearTimeout(wait.timer), (wait.timer = setTimeout(tick, after)))
  return {
    hedged(kind) {
      wait.hedge = kind === 'backup' ? 'trying the backup model' : 'asking again'
      if (wait.shown) say(HEDGE_LINES[kind], false)
    },
    async *pass(chunks) {
      const word = sight()
      arm()
      try {
        for await (const chunk of chunks) {
          if (chunk.type === 'finish') clearTimeout(wait.timer)
          else if (word(chunk)) {
            if (wait.shown) say(`The model answered after ${seconds()} s.`, false)
            Object.assign(wait, { from: Date.now(), shown: false })
            arm()
          }
          yield chunk
        }
      } finally {
        clearTimeout(wait.timer)
      }
    },
  }
}
