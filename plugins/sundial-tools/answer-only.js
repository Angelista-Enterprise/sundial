// A tool whose result IS the answer: the chat call right after it goes without tools, so the model says it and the turn ends.
//
// gnomon_pull_up finds the thing, raises it and rings it, and its result is the one sentence to say. Runs 179 and 183 had
// the right document in front and the mark placed within 4 s, then 12 and 17 model steps: a shell hunt through the rig's
// own folders for "the line I changed", which the record does not hold (keys are counted, never read). The tool's own
// "say exactly this, nothing more" did not hold the model in three rounds of wording; dropping the tools does.
//
// The adapter drops them (sundial-llm-openai serializeRequest), not an `llm/stream` listener: cordis's waterfall calls every
// listener with the original arguments (what one hands `next` is dropped) and dsh freezes the request, so the listener this
// was first (Set 3 R1) never took a tool away (run 192 T09: 9 model steps after the pull-up).
//
// Named exports only.
import { DISPATCH_TOOL_NAME, unwrap } from './layers.js'

/** Tools whose successful result is the reply. */
export const ANSWERING_TOOLS = new Set(['gnomon_pull_up'])

const argsOf = (raw) => {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw ?? '')) } catch { return {} }
}
/** The tool a call block meant: its own name, or the one inside gnomon_call. */
const meant = (block) => (block.name === DISPATCH_TOOL_NAME ? unwrap(argsOf(block.arguments)).name : block.name)
const results = (message) => (message?.role === 'tool' ? [message] : (message?.content ?? []).filter((b) => b?.type === 'tool-result'))

/**
 * Tool-call syntax a model printed as text instead of calling a tool. Run 209 T12: on the tool-less call after a worked
 * pull-up, minimax (through openrouter) answered "]<]minimax[>[<tool_call> ... <invoke name="gnomon_call"> ..." and that
 * was said to the owner.
 */
export const TOOL_MARKUP = /<\/?tool_call\b|<invoke\s+name=|\]<\]minimax\[>\[|<\|tool_call|<｜tool▁call|```tool_code/i

/** Said when a reply was nothing but tool-call markup and no tool's sentence stands in for it. */
export const GARBLED = 'My answer came out garbled, so I left it unsaid. Ask me again.'

/**
 * A model's reasoning printed as text. Run 249 T21: minimax (through openrouter) answered "\n</mm:think>\n Look's look line
 * action ...", and the stray tag and the thought before it reached the owner. <think>, <thinking>, <reasoning>, each with or
 * without an `mm:` prefix.
 */
const THOUGHT = '(?:mm:)?(?:think|thinking|reasoning)'
export const THINK_TAG = new RegExp(`<\\/?${THOUGHT}>`, 'i')
/** What the slip holds back while a reply streams: from the first of these on, nothing is said before the reply's end. */
export const HELD = new RegExp(`${TOOL_MARKUP.source}|${THINK_TAG.source}`, 'i')

/** Run 250 T19 (doc 30): a lone "█" (a stream's cursor) reached an answer. A line that is one block or cursor character, nothing else. */
const CURSOR = '[█▌▐▍▎▏▊▉■▮▯]'
export const LONE_CURSOR = new RegExp(`^\\s*${CURSOR}\\s*$`)
/** `text` without its cursor lines. */
export const uncursored = (text) => String(text ?? '').replace(new RegExp(`^[ \\t]*${CURSOR}[ \\t]*(?:\\r?\\n|$)`, 'gm'), '')

/** `text` without its thought: every tagged block, all before a closing tag with no opening one, all after an opening tag never closed. */
export function unthought(text) {
  const paired = String(text ?? '').replace(new RegExp(`<${THOUGHT}>[\\s\\S]*?<\\/${THOUGHT}>`, 'gi'), '')
  const close = [...paired.matchAll(new RegExp(`<\\/${THOUGHT}>`, 'gi'))].at(-1)
  const after = close ? paired.slice(close.index + close[0].length) : paired
  const open = after.search(new RegExp(`<${THOUGHT}>`, 'i'))
  return open < 0 ? after : after.slice(0, open)
}

const textOf = (r) => (typeof r?.content === 'string' ? r.content : (r?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'))

/** The sentence the answering tool's newest result says to say ("Say exactly this ...: "Here is ..."), or null. */
export function answerSentence(messages) {
  const texts = (Array.isArray(messages) ? messages : []).flatMap(results).map(textOf).reverse()
  for (const text of texts) {
    const said = /Say exactly this[^"]*"([\s\S]+)"\s*$/.exec(text)?.[1]
    if (said) return said
  }
  return null
}

/**
 * A reply as it may be said. Right after an answering tool that worked: that tool's own sentence, alone: the prompt line
 * "say exactly this" held three runs in four, so the code holds it. Else cut at the first tool-call markup, and markup
 * alone becomes a short honest line.
 */
export function sayable(text, messages) {
  // Set 4 R1: after a worked answering tool, its sentence IS the reply, whatever the model wrote around or instead of it.
  const line = answered(messages) && answerSentence(messages)
  if (line) return line
  // Run 249 T21: the thought goes first; a reply that was all thought is GARBLED, not an empty answer.
  const plain = uncursored(text)
  const clean = THINK_TAG.test(plain) ? unthought(plain) : plain
  if (clean !== plain && !clean.trim()) return GARBLED
  const at = String(clean ?? '').search(TOOL_MARKUP)
  if (at < 0) return clean
  return clean.slice(0, at).trim() || GARBLED
}

/** The newest step of the conversation was an answering tool that worked: nothing but its results came after it. */
export function answered(messages) {
  const list = Array.isArray(messages) ? messages : []
  const last = list.findLastIndex((m) => m?.role === 'assistant')
  if (last < 0) return false
  const calls = (list[last].content ?? []).filter((b) => b?.type === 'tool-call')
  if (!calls.some((b) => ANSWERING_TOOLS.has(meant(b)))) return false
  const after = list.slice(last + 1)
  // An owner message after the call is a new ask; an errored result (a bad call) may be tried again.
  if (after.length === 0 || after.some((m) => m?.role === 'user' && results(m).length === 0)) return false
  return !after.flatMap(results).some((r) => r.isError === true)
}
