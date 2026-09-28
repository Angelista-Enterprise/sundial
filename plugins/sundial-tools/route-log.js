// Route before ask — logged, not used (J1.4b).
//
// On every owner message, Jev predicts which data sources the question needs
// (`route-ask`: one probability per tool, plus difficulty). The prediction is
// written to the log as `ask:route-predicted`; when the turn ends, the tools
// the loop ACTUALLY called follow as `ask:route-actual`. Nothing routes on it:
// the bench put the judge and the loop at a Jaccard of 0.34, which is enough
// to pre-select and not enough to forbid. A month of these pairs decides
// (docs/jarvis/04, J1.4: exclusion only at Jaccard ≥ 0.5).
//
// The question is stored under `query`, a field sanitize-at-ingest already
// runs its secret patterns over, so a pasted token in a chat message never
// reaches the log — and it is clipped to 200 chars: the log records what was
// asked, dsh's own session log records the conversation.
import { isOwnerMessage, parseLoose, textOf } from '../sundial-theme/shell/frames.js'
import { DISPATCH_TOOL_NAME } from './layers.js'
import { ROUTE_TOOLS, routeAsk } from '@sundial/rules/questions/route-ask.js'

export const COMPANION_SESSION_ID = 'gnomon-companion'
const QUESTION_MAX = 200
const MIN_QUESTION_CHARS = 3

/**
 * @param {{ judgeNow: Function, appendSignal: Function, skipSessions?: Set<string>, log?: Function, warn?: Function }} deps
 * @returns {(session: { id?: string } | undefined, event: { type?: string, id?: string, ts?: string, data?: any } | undefined) => void}
 */
export function createRouteLog({ judgeNow, appendSignal, skipSessions = new Set([COMPANION_SESSION_ID]), log = console.log, warn = console.warn }) {
  /** Open turns by session: the question asked and the tools called so far. */
  const turns = new Map()

  const record = (type, payload) =>
    Promise.resolve(appendSignal(type, payload)).catch((error) => warn(`[sundial-tools] route log could not record ${type}: ${error instanceof Error ? error.message : String(error)}`))

  return function onSessionEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || skipSessions.has(sessionId)) return
    const type = event?.type
    const data = event?.data ?? {}

    if (type === 'user/message') {
      if (!isOwnerMessage(data)) return
      const question = textOf(data).trim()
      if (question.length < MIN_QUESTION_CHARS) return
      const turnId = typeof event.id === 'string' && event.id !== '' ? event.id : `${sessionId}@${event.ts ?? new Date().toISOString()}`
      turns.set(sessionId, { turnId, tools: new Set() })
      const built = routeAsk.build({ question })
      void Promise.resolve(judgeNow({ purpose: 'rank', questionSetId: routeAsk.id, momentId: null, state: built.state, questions: built.questions }))
        .then((judged) => {
          if (judged === null || judged === undefined) return
          const a = judged.answers ?? {}
          const predicted = Object.fromEntries(Object.keys(ROUTE_TOOLS).map((name) => [name, typeof a[name]?.noul === 'number' ? Number(a[name].noul.toFixed(3)) : null]))
          const top = Object.values(a.difficulty?.probabilities ?? {}).filter((v) => typeof v === 'number')
          return record('ask:route-predicted', {
            sessionId,
            turnId,
            query: question.slice(0, QUESTION_MAX),
            predicted,
            difficulty: typeof a.difficulty?.score === 'number' ? Math.round(a.difficulty.score) : null,
            difficultyP: top.length > 0 ? Number(Math.max(...top).toFixed(3)) : null,
            needsLive: typeof a.needs_live_data?.noul === 'number' ? Number(a.needs_live_data.noul.toFixed(3)) : null,
            aboutAssistant: typeof a.about_the_assistant?.noul === 'number' ? Number(a.about_the_assistant.noul.toFixed(3)) : null,
            model: judged.model ?? null,
          })
        })
        .catch((error) => warn(`[sundial-tools] route prediction failed: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    const turn = turns.get(sessionId)
    if (!turn) return
    if (type === 'tool/call') {
      if (typeof data.name !== 'string' || data.name === '') return
      // A cold tool is reached through `gnomon_call({ name })`: the door is not
      // the tool. Recording the door made the first live pair read Jaccard 0
      // against a prediction that had named the right tool behind it.
      const behind = data.name === DISPATCH_TOOL_NAME ? parseLoose(data.arguments)?.name : null
      turn.tools.add(typeof behind === 'string' && behind !== '' ? behind : data.name)
      return
    }
    if (type === 'turn/end') {
      turns.delete(sessionId)
      const tools = [...turn.tools]
      log(`[sundial-tools] route log: turn ${turn.turnId} called ${tools.length === 0 ? 'no tools' : tools.map((t) => t.replace(/^gnomon_/, '')).join(',')}`)
      void record('ask:route-actual', { sessionId, turnId: turn.turnId, tools })
    }
  }
}
