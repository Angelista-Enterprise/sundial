// Old screen dumps, replaced by a line that says what they were.
//
// A look of one window is about sixty lines, and a turn keeps every one of them in the history for
// every later call. Run 14's prompts ran from 8,500 to 42,000 tokens, and most of that mass is screens
// that have since changed. The published result on another agent benchmark is that replacing older
// OBSERVATIONS with a placeholder — while keeping every action and every piece of reasoning — removes
// about half the cost with no measurable loss, and beats summarising them, because a summary hides the
// signals that say the task is finished.
//
// Our own A/B bench says the same thing from the other side: a hand-written summary of the task did
// WORSE than the raw history. So this never summarises. It keeps the newest looks exactly as they are,
// and replaces the ones the screen has moved past with one line naming what was there.
//
// Off unless `experiments.maskOldLooks` is on, and benched before it is trusted.
//
// Named exports only.
import { auditPurpose } from './audit.js'

/** A look's own first line: "App, window "…" (look-1234abcd): 42 things". The one line worth keeping. */
const HEAD = /^[^\n]*\(look-[0-9a-f]{8}\)[^\n]*/

/** How many of the newest looks stay whole. The one in front, and the one before it for a comparison. */
export const KEPT_WHOLE = 2

/** Is this result a look of a screen (its own head line says so), and how long is it? */
export const looksLikeScreen = (text) => typeof text === 'string' && text.length > 400 && HEAD.test(text)

/**
 * The messages as the model should see them: the newest looks whole, the older ones one line each.
 *
 * Pure, and it never touches an action, a reasoning block, a shell result or anything the model wrote.
 * Returns the same array when nothing is masked, so a caller can tell cheaply whether it changed.
 */
export function maskOldLooks(messages, keep = KEPT_WHOLE) {
  const list = Array.isArray(messages) ? messages : []
  // Find every screen result first, so "the newest few" is counted over the whole conversation.
  const found = []
  for (const [m, message] of list.entries()) {
    for (const [b, block] of (message?.content ?? []).entries()) {
      if (block?.type !== 'tool-result') continue
      for (const [c, inner] of (block.content ?? []).entries()) if (looksLikeScreen(inner?.text)) found.push({ m, b, c, text: inner.text })
    }
  }
  const stale = found.slice(0, Math.max(0, found.length - keep))
  if (stale.length === 0) return list
  const at = new Map(stale.map((s) => [`${s.m}.${s.b}.${s.c}`, s.text]))
  return list.map((message, m) => {
    if (!(message?.content ?? []).some((_, b) => (message.content[b]?.content ?? []).some((_2, c) => at.has(`${m}.${b}.${c}`)))) return message
    return {
      ...message,
      content: message.content.map((block, b) => {
        if (block?.type !== 'tool-result') return block
        return {
          ...block,
          content: (block.content ?? []).map((inner, c) => {
            const was = at.get(`${m}.${b}.${c}`)
            if (was === undefined) return inner
            const head = (was.match(HEAD) ?? [''])[0]
            return { ...inner, text: `${head}\n[this screen has changed since: ${was.split('\n').length} lines of it are not shown. Look again if you need it.]` }
          }),
        }
      }),
    }
  })
}

/** The `llm/stream` listener: only the chat, only when the owner switched it on. */
export function maskOldLooksGuard({ getState }) {
  return async function* mask(options, next) {
    // The chat's own calls carry no `purpose` at all, which is why the first version of this never fired:
    // run 17 masked nothing in 43 calls. `auditPurpose` is the rule the ledger already uses — no purpose
    // means the chat — so this now reads the same thing the audit does.
    const on = getState()?.config?.experiments?.maskOldLooks === true
    const messages = on && auditPurpose(options) === 'ask' ? maskOldLooks(options.messages) : options?.messages
    yield* next(messages === options?.messages ? options : { ...options, messages })
  }
}
