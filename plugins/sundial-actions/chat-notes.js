// Chat notes, and compaction after the turn instead of inside it.
//
// dsh compacts a full chat between two steps of a running turn: the owner watches
// a frozen screen while the model summarizes (measured 2026-11-12: 13.7 s, 12.5 s
// and 28.4 s inside one screen task). Here the work moves to the end of the turn:
//
// 1. After every turn a small background call folds that turn into the chat's
//    notes (old notes + the new messages → new notes). The idea is the "context
//    file" of Context Language Models (arXiv 2609.37725), kept by Sundial.
// 2. Then, only when the prompt has reached the compaction point, the chat is made
//    short while it is idle: old tool output (screen looks, page text) is cut to a
//    glimpse first, which costs no model call and keeps every word; if that is not
//    enough, the notes plus a rendered tail of the latest exchange replace the
//    rest. The next turn starts short and nothing runs inside it. With
//    `llm.compactKeepFront` (off by default) the front of the chat (system prompt, tools, its first brief, earlier checkpoints) is left as it
//    was and the new checkpoint goes behind it (`spanAfterPrefix`), so the provider's
//    prompt cache survives the compaction up to there.
//
// dsh's own in-turn compaction stays as the overflow guard: the route declares the
// model's real window, so it fires only when one turn alone outgrows half of it.
//
// One file per chat, $SUNDIAL_HOME/chat-notes/<session id>.json: the notes and the
// ids of the messages they cover, so a chat picks up where it was after a restart.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlockAssembler, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { getSundialHome } from '@sundial/helpers/config.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'

export const NOTES_PURPOSE = 'chat-notes'
/** ~2k tokens: the span notes replace is tens of thousands, so a checkpoint always shrinks it. */
export const NOTES_MAX_CHARS = 8000
/** One message's share of an update; a whole day of tool rows is not what the notes are for. */
const PART_MAX_CHARS = 1500
/**
 * Prompt tokens at which a chat is compacted after its turn. config.json `llm.compactAt` overrides it.
 * 100k let live test run 3 (2026-11-12) grow prompts 50k → 104k across tasks. Bench the same day, this
 * code replayed over the real chat: cutting old tool output never got a screen-heavy chat under half
 * the point (0.55 to 0.74 of it at 40k to 150k), so every compaction takes the notes path, and the
 * prompt after it is the same bytes at 60k and at 100k. Probes after it (glm-5.3-flash, n=4 each):
 * 3 of 4 held at both; the miss (a feed detail from 156k back) was never in the notes. So the point
 * sets how long raw detail stays before the notes take over, not what survives them.
 */
export const COMPACT_AT = 60_000
/** A rendered tail: the last few exchanges, words clipped long and tool output short. */
const TAIL_CLIP = { words: 1500, tools: 200 }
const TAIL_MAX_CHARS = 4000
/** The checkpoint's preamble and tags, which dsh adds around a summary, priced generously. */
const FRAME_TOKENS = 200

const INSTRUCTION = `You keep the working notes for a conversation between the owner and Gnomon, their assistant. When the conversation gets long, its oldest part is replaced by these notes, so anything not in them is lost to Gnomon.

Above are the current notes (if any) and the newest part of the conversation. Return the updated notes and nothing else: terse Markdown bullets under these headings, with "(none)" for an empty one:

## What the owner wants
## Decisions and facts
## Open threads and promises
## Tried and failed

Keep what still holds. Correct what changed (a new date replaces the old one). Drop what is settled and no longer matters. Keep names, numbers, dates, paths and ids exact. Copy every number and date exactly as the owner gave it. Never add anything the conversation does not say. At most ${NOTES_MAX_CHARS} characters.`

const notesDir = () => join(getSundialHome(), 'chat-notes')
const notesFile = (dir, sessionId) => join(dir, `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`)
const clipTo = (max) => (text) => (text.length > max ? `${text.slice(0, max)} …` : text)

/** A chat's notes: `{ notes, covered: [message id] }`, or null. */
export function readNotes(dir, sessionId) {
  try {
    const saved = JSON.parse(readFileSync(notesFile(dir, sessionId), 'utf8'))
    return typeof saved.notes === 'string' && Array.isArray(saved.covered) ? saved : null
  } catch {
    return null
  }
}

export function writeNotes(dir, sessionId, notes, covered) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(notesFile(dir, sessionId), JSON.stringify({ notes, covered }), { mode: 0o600 })
}

/**
 * The conversation as the notes call reads it: one line per part, who said it
 * first. The per-turn brief, notices and dsh's reminders are left out: on the
 * first live run they were most of the text and the notes got the owner's
 * budget wrong.
 */
export function transcript(messages, { words = PART_MAX_CHARS, tools = PART_MAX_CHARS } = {}) {
  const word = clipTo(words)
  const tool = clipTo(tools)
  const lines = []
  for (const message of messages) {
    // A user-role message that neither the owner nor a tool produced is context (the brief, a
    // notice, dsh's own reminders and checkpoints, whatever kind they carry): not conversation.
    // The system prompt leads a compaction's input; it is not the owner speaking.
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user' && message.source?.kind !== 'user' && message.source?.kind !== 'tool') continue
    // dsh 0.2 (format V4): a tool result is its own `tool` message.
    if (message.role === 'tool') {
      const text = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      lines.push(`${message.isError ? 'Tool error' : 'Tool result'}: ${tool(text.trim())}`)
      continue
    }
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text.trim() && !block.text.trimStart().startsWith('<system-reminder>')) {
        lines.push(`${message.role === 'assistant' ? 'Gnomon' : 'Owner'}: ${word(block.text.trim())}`)
      } else if (block.type === 'tool-call') {
        lines.push(`Gnomon called ${block.name} ${tool(String(block.arguments ?? ''))}`)
      } else if (block.type === 'tool-result') {
        const text = (block.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        lines.push(`${block.isError ? 'Tool error' : 'Tool result'}: ${tool(text.trim())}`)
      }
    }
  }
  return lines.join('\n\n')
}

/** The notes call's one message: the current notes, the messages they do not cover yet, the instruction. */
export const notesPrompt = (notes, fresh) => `Current notes:\n${notes || '(none yet)'}\n\nNewest part of the conversation:\n${transcript(fresh)}\n\n${INSTRUCTION}`

/** The latest messages as a transcript of at most `budget` characters, oldest first. */
export function renderTail(messages, budget) {
  const parts = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const part = transcript([messages[i]], TAIL_CLIP)
    if (!part) continue
    if (parts.reduce((n, p) => n + p.length + 2, 0) + part.length > budget) break
    parts.unshift(part)
  }
  return parts.join('\n\n')
}

/** dsh's checkpoint framing (dsh-compaction-basic `CHECKPOINT_PREAMBLE`), restated for `compactSpan`. */
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
/** At most this share of the compaction point may stay ahead of a compacted span; past it, one compaction rewrites the chat. */
export const KEEP_SHARE = 0.5

const toolCalls = (event) => (event?.type === 'assistant/message' ? (event.data?.message?.content ?? []).filter((block) => block.type === 'tool-call').length : event?.type === 'tool/result' ? -1 : 0)
const sourceOf = (event) => (event?.type === 'user/message' ? (event.data?.source ?? {}) : {})

/** Whether the chat's latest compaction opened and never closed (dsh refuses a new one then). */
function compactionOpen(session) {
  for (let seq = (session.seq ?? 0) - 1; seq >= 0; seq--) {
    const type = session.eventAt(seq)?.type
    if (type === 'compaction/end') return false
    if (type === 'compaction/start') return true
  }
  return false
}

/**
 * What an after-turn compaction replaces when it can leave the front of the chat alone (Set 2 Round 2 item 3):
 * the priced nodes after the chat's first brief and the last checkpoint, up to the last reply. The system prompt,
 * the tools, that brief (the owner's standing memory, ~7k tokens) and the checkpoints before stay the same bytes,
 * so the provider's cache still holds them and the brief after it re-sends only what left (`gnomonKernel.brief`).
 * Each compaction appends one checkpoint behind the last; once the kept front passes KEEP_SHARE of the compaction
 * point, or a chat has no brief, null: the whole chat is compacted once, as before.
 */
export function spanAfterPrefix(session, nodes, at) {
  if (typeof session.eventAt !== 'function') return null
  const events = nodes.map((node) => session.eventAt(node.seq))
  if (events[0]?.type !== 'system/message') return null
  const brief = events.findIndex((event) => sourceOf(event).kind === 'sundial-shell' && sourceOf(event).form === 'notice')
  const keep = Math.max(brief, events.findLastIndex((event) => sourceOf(event).kind === 'compact-checkpoint'))
  if (keep < 1 || nodes.slice(1, keep + 1).reduce((sum, node) => sum + node.tokens, 0) > at * KEEP_SHARE) return null
  // A cut is balanced where no tool call waits for its result; the last reply always stays a real message.
  // dsh's own toolPairingBalancedBefore/After live in @deepseek-ai/dsh-compaction, which this plugin cannot import
  // without a new dependency entry, so the same count (calls in an assistant message, minus tool results) is kept here.
  const open = events.reduce((sums, event) => [...sums, (sums.at(-1) ?? 0) + toolCalls(event)], [])
  const end = open.findLastIndex((n, i) => n === 0 && i < nodes.length - 1)
  return open[keep] === 0 && end > keep ? nodes.slice(keep + 1, end + 1) : null
}

/**
 * The engine's config. dsh 0.2's default `headroomTokens` is 65536: on a 64k window
 * the pressure budget is nil, `resolveCompactSpec` throws once per target and the
 * overflow guard never runs. 8k headroom over an 8k output reservation fits any
 * window from 64k up; the summary call gets 8k tokens.
 */
export const NOTES_COMPACTION_CONFIG = { headroomTokens: 8192, maxTokens: 8192 }

/** dsh's compaction engine, run after the turn, with the chat's notes as the summary when they cover the span. */
export class NotesCompaction extends BasicCompactionEngine {
  dir = notesDir()
  compactAt = loadSundialConfig().llm.compactAt ?? COMPACT_AT
  /** config.json `llm.compactKeepFront`: keep the chat's front (`spanAfterPrefix`). Off: the whole chat, as before. */
  keepFront = loadSundialConfig().llm.compactKeepFront === true
  /** Session id → the job in flight, so one chat's jobs run one at a time, in order. */
  updates = new Map()
  /** Session id → the summary an after-turn compaction lands, while it runs. */
  summaries = new Map()
  /** Sessions already told their notes do not fit, so the log says it once. */
  warned = new Set()

  constructor(ctx, config) {
    super(ctx, config)
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && agent?.session) this.queueUpdate(agent.session, agent)
    })
    console.log(`[sundial-actions] compaction: after the turn, at ${this.compactAt} prompt tokens; chat notes kept in ${this.dir}`)
  }

  queueUpdate(session, agent) {
    const previous = this.updates.get(session.id) ?? Promise.resolve()
    const next = previous
      .then(() => this.updateNotes(session))
      .catch((error) => console.warn(`[sundial-actions] chat notes not updated: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => agent && this.compactAfterTurn(agent))
      .catch((error) => console.warn(`[sundial-actions] after-turn compaction skipped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (this.updates.get(session.id) === next) this.updates.delete(session.id) })
    this.updates.set(session.id, next)
    return next
  }

  /** Fold the messages the notes do not cover yet into them: one call, with the chat's own model. */
  async updateNotes(session) {
    const target = session.requestHeader()?.config
    if (!target?.provider || !target?.model) return
    const messages = session.deriveMessages()
    const saved = readNotes(this.dir, session.id)
    const covered = new Set(saved?.covered ?? [])
    const fresh = messages.filter((message) => message.role !== 'system' && !covered.has(message.id))
    if (fresh.length === 0) return
    const assembler = new BlockAssembler()
    const stream = this.ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({ content: [{ type: 'text', text: notesPrompt(saved?.notes, fresh) }], source: { kind: 'sundial-actions' } })],
      maxTokens: 8192,
      sessionId: session.id,
      purpose: NOTES_PURPOSE,
    })
    for await (const chunk of stream) assembler.push(chunk)
    if (assembler.finish.kind !== 'stop') throw new Error(`the model call ended with ${assembler.finish.kind}`)
    const notes = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    if (!notes) throw new Error('the model returned no notes')
    writeNotes(this.dir, session.id, notes.slice(0, NOTES_MAX_CHARS), messages.map((message) => message.id))
  }

  /**
   * Make an idle chat short before its next turn, only when it has reached the compaction
   * point: half the declared window at most, so one turn can grow without dsh compacting in it.
   */
  async compactAfterTurn(agent) {
    const { session } = agent
    const target = session.requestHeader()?.config
    if (!target?.provider || !target?.model) return
    const window = (await this.ctx.llm.resolveModelInfo(target.provider, target.model)).context?.contextWindow
    const at = Math.min(this.compactAt, window ? Math.floor(window / 2) : Infinity)
    const tokens = () => this.ctx.tokenMeter.measure(session).totalTokens
    const before = tokens()
    if (before < at) return
    // ponytail: no cutting of old tool output first. Its replace events land outside a turn, which dsh refuses on reload
    // (the companion log would not load, 2026-11-12), and it never got a chat under half the point anyway.
    // The notes must cover the chat, or the summary would be a model call the owner's next message waits on.
    const saved = readNotes(this.dir, session.id)
    if (!saved?.covered.includes(session.deriveMessages().at(-1)?.id)) return console.log('[sundial-actions] after-turn compaction: the notes lag the chat; next turn')
    const nodes = this.ctx.tokenMeter.measure(session).nodes
    const span = this.keepFront ? spanAfterPrefix(session, nodes, at) : null
    const kept = span && this.fittingSummary(session, saved.notes, span)
    if (kept) {
      await this.compactSpan(agent, span, kept)
      return console.log(`[sundial-actions] after-turn compaction, first ${nodes.indexOf(span[0])} nodes kept: ${before} → ${tokens()} tokens`)
    }
    const summary = this.fittingSummary(session, saved.notes, nodes.slice(1, -1))
    if (summary === null) {
      if (!this.warned.has(session.id)) console.log(`[sundial-actions] after-turn compaction: the notes would not be smaller than what they replace in ${session.id}; skipped`)
      this.warned.add(session.id)
      return
    }
    this.summaries.set(session.id, summary)
    try {
      await this.compactNow(agent, new AbortController().signal)
    } finally {
      this.summaries.delete(session.id)
    }
    console.log(`[sundial-actions] after-turn compaction: ${before} → ${tokens()} tokens`)
  }

  /**
   * Replace `span` (priced surface nodes, contiguous, balanced) with a checkpoint holding `text`, while the chat is
   * idle. This is dsh's manual compaction transaction (`compactSurfaceRegion` in @deepseek-ai/dsh-compaction-basic,
   * the path `compactNow` takes) with the same four events in the same order; only the span is ours, because
   * `compactNow` always starts at the node after the system prompt.
   */
  compactSpan(agent, span, text) {
    const { session } = agent
    const [start, end] = [span[0].seq, span.at(-1).seq]
    const shadowedSeqs = span.map((node) => node.seq)
    return agent.runMaintenance(async () => {
      if (compactionOpen(session)) throw new Error('a compaction is still open in this chat')
      const compactionId = randomUUID()
      const lifecycle = { compactionId, turn: null }
      const opened = session.append('compaction/start', lifecycle)
      try {
        const summary = [{ type: 'text', text }]
        const noted = session.append('compaction/summary', { compactionId, summary, shadowedRange: { start, end }, shadowedSeqs, shadowedTokenCount: span.reduce((sum, node) => sum + (node.heuristicTokens ?? node.tokens), 0), provider: 'sundial', model: NOTES_PURPOSE })
        const checkpoint = createUserMessage({ content: [{ type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` }, ...summary, { type: 'text', text: '</compacted-summary>' }], source: { kind: 'compact-checkpoint', compactionId } })
        session.append('user/message', checkpoint, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [opened.seq, noted.seq, ...shadowedSeqs] })
      } catch (error) {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        throw error
      }
      session.append('compaction/end', lifecycle)
      await this.ctx.sessions?.flush(session)
    })
  }

  /**
   * The notes plus the latest exchange, or the notes alone, whichever is smaller than `span`, the
   * priced nodes it replaces; dsh refuses a summary that does not shrink it, and the chat would
   * retry on every idle. Null when neither fits.
   */
  fittingSummary(session, notes, span) {
    const meter = this.ctx.tokenMeter
    const replaced = span.reduce((sum, node) => sum + node.tokens, 0)
    const tail = renderTail(session.deriveMessages().slice(0, -1), TAIL_MAX_CHARS)
    const fits = (text) => meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] }) + FRAME_TOKENS < replaced
    return [tail ? `${notes}\n\n## The latest exchange, as it went\n${tail}` : notes, notes].find(fits) ?? null
  }

  async summarize(input, agent, signal) {
    const saved = readNotes(this.dir, agent.session.id)
    const last = input.messages.at(-1)
    if (saved !== null && last !== undefined && saved.covered.includes(last.id)) {
      const text = this.summaries.get(agent.session.id) ?? saved.notes
      console.log(`[sundial-actions] compaction: the chat notes stand in (${text.length} characters, no model call)`)
      return { summary: [{ type: 'text', text }], provider: 'sundial', model: NOTES_PURPOSE }
    }
    return super.summarize(input, agent, signal)
  }
}
