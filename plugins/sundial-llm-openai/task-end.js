// Set 5 R1 (plan 21, 2C): a chat's turn ends, and nothing knew whether its task did. Six tasks in runs 211 to 228 ended on a
// status report with work left ("Gift wrap still unticked and Submit not yet pressed"). Two of dsh's own turn hooks, no state here:
//   - `agent/turn-stopping` (the model owes nothing more): when this chat's task has a refused step after its last done one, no final
//     and no ask since it began, and no nudge yet, the turn gets one more step with FINISH_NUDGE. `task:nudged` is folded before the
//     steer, so the next stop of the same turn (or task) reads it and lets the turn close. A Stop aborts the turn before this hook runs.
//     Review S5R1: read against the chat's own log (needsNudge): only the task's own turn (H1), only after a refusal the model can get
//     past (H2), only when the turn's newest tool result is an error (M1). A Stopped turn folds `task:ended {stopped}`, which ends it.
//   - `session/event` `turn/end` (done, failed or stopped: dsh appends it in a finally): `task:ended` with the outcome (helpers task-of.ts),
//     and the id of the task that was current when the turn began (Review S5R1 L2: a withdrawn stale turn ends after the next task began).
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FINISH_NUDGE, NUDGE_SOURCE, needsNudge, outcomeOf, taskOf, taskOfTurn } from '@sundial/helpers/task-of.js'

/** @param {{ getState: () => object | null | undefined, appendSignal: (type: string, payload: object) => Promise<void> | void }} deps */
export function createTaskEnd({ getState, appendSignal }) {
  return {
    /** `agent/turn-stopping`: `{ agent, turn, signal }`. */
    async stopping({ agent, turn, signal }) {
      const sessionId = String(agent?.id ?? '')
      if (signal?.aborted || !needsNudge(getState(), sessionId, agent?.session?.snapshotEvents?.())) return
      // The fold is the once-guard: no nudge unless its row landed, so a failed write can never let a second one through.
      await Promise.resolve(appendSignal('task:nudged', { sessionId, turn })).catch(() => {})
      if (signal?.aborted || taskOf(getState(), sessionId)?.nudged === undefined) return
      try {
        agent.steer(createUserMessage({ content: [{ type: 'text', text: FINISH_NUDGE }], source: { ...NUDGE_SOURCE } }))
      } catch {
        // A nudge that cannot be sent lets the turn close as it would have; the row says it was due.
      }
    },
    /** `session/event`: on `turn/end`, the outcome of this chat's task, when the chat has one and the turn began in it. */
    ended(session, event) {
      if (event?.type !== 'turn/end') return
      const sessionId = String(session?.id ?? '')
      const state = getState()
      const events = session?.snapshotEvents?.() ?? null
      const task = taskOfTurn(state, sessionId, events, event.data?.turn)
      if (task === null) return
      const outcome = outcomeOf(state, sessionId, event.data?.reason, events)
      void Promise.resolve(appendSignal('task:ended', { sessionId, taskId: task.id, outcome, turn: event.data?.turn ?? null })).catch(() => {})
    },
  }
}
