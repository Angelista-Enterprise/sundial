// The chat recorder (W1).
//
// Every owner message and every reply, in every session the owner talks in —
// the conversation included — goes to the log as `chat:owner` and `chat:said`,
// so the fold knows what was said and when (`conversationTrack`). A subagent's
// session is skipped: its "user" turns are another agent's instructions. The
// words sit under `text`, which sanitize-at-ingest runs its secret and PII
// passes over, and are clipped (1,200 and 2,000 characters); a reply's tools
// are names only, never arguments or results. Each row carries the time dsh
// stamped on the message, so an owner's promise gets the same id the nightly
// pass over the session log would mint.
//
// J1.4b's route prediction (Jev guessing, on every owner message, which data
// sources the question needs) is retired (W5 step 8): scored against the tools
// the turns then called, its Brier skill was -0.20 against each source's base
// rate (145 turns, 2,465 pairs), so it was worse than no predictor, at a model
// call per message. `read/route-predictor.ts` keeps the scorer.
import { isOwnerMessage, parseLoose, textOf } from '../sundial-theme/shell/frames.js'
import { DISPATCH_TOOL_NAME } from './layers.js'

const OWNER_MAX = 1200
const SAID_MAX = 2000
const TOOLS_MAX = 20

/**
 * @param {{ appendSignal: Function, log?: Function, warn?: Function }} deps
 * @returns {(session: { id?: string, header?: { origin?: string } } | undefined, event: { type?: string, time?: number, data?: any } | undefined) => void}
 */
export function createRouteLog({ appendSignal, log = console.log, warn = console.warn }) {
  /** Open turns by session: the owner message that opened it, the reply so far, the tools called. */
  const turns = new Map()

  const record = (type, payload, ts) =>
    Promise.resolve(appendSignal(type, payload, ts)).catch((error) => warn(`[sundial-tools] chat recorder could not record ${type}: ${error instanceof Error ? error.message : String(error)}`))

  return function onSessionEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || session?.header?.origin === 'subagent') return
    const type = event?.type
    const data = event?.data ?? {}
    const at = Number.isFinite(event?.time) ? new Date(event.time).toISOString() : undefined

    if (type === 'user/message') {
      if (!isOwnerMessage(data)) return
      const text = textOf(data).trim()
      if (text === '') return
      const turnId = typeof data.id === 'string' && data.id !== '' ? data.id : `${sessionId}@${at ?? ''}`
      turns.set(sessionId, { ...(turns.get(sessionId) ?? { texts: [], tools: new Set() }), turnId })
      const images = Array.isArray(data.content) ? data.content.filter((b) => b?.type === 'image').length : 0
      void record('chat:owner', { sessionId, turnId, text: text.slice(0, OWNER_MAX), chars: text.length, images }, at)
      return
    }
    // A turn nobody typed (a notice waking the conversation, a job) is recorded too.
    const turn = turns.get(sessionId) ?? { turnId: null, texts: [], tools: new Set() }
    if (type === 'assistant/message') {
      const text = textOf(data.message).trim()
      if (text !== '') turns.set(sessionId, { ...turn, texts: [...turn.texts, text] })
      return
    }
    if (type === 'tool/call') {
      if (typeof data.name !== 'string' || data.name === '' || turn.tools.size >= TOOLS_MAX) return
      // A cold tool is reached through `gnomon_call({ name })`: the door is not the tool.
      const behind = data.name === DISPATCH_TOOL_NAME ? parseLoose(data.arguments)?.name : null
      turn.tools.add(typeof behind === 'string' && behind !== '' ? behind : data.name)
      turns.set(sessionId, turn)
      return
    }
    if (type === 'turn/end') {
      turns.delete(sessionId)
      const text = turn.texts.join('\n\n')
      const tools = [...turn.tools]
      log(`[sundial-tools] chat recorder: ${sessionId} turn ${data.turn ?? '?'} said ${text.length} chars, ${tools.length === 0 ? 'no tools' : tools.map((t) => t.replace(/^gnomon_/, '')).join(',')}`)
      if (text === '') return
      void record('chat:said', { sessionId, turnId: turn.turnId ?? `${sessionId}#${data.turn ?? ''}`, text: text.slice(0, SAID_MAX), chars: text.length, tools }, at)
    }
  }
}
