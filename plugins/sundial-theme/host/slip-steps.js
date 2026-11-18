// A screen step's words on the slip's doing line, and a refused step's recovery line (Set 4 R1, "recovery named").
//
// Set 2 R5: each step's own words (screen-tools.js `stepLine`) go to the chat it runs in, and app.js puts them on the running
// screen_act row, which the slip reads as its doing line (slip-read.js `doingOf`). A refused step said nothing there: NEXT.md 2,
// "a refused act is a dead end in a list". Now the refusal is a line of its own at once ("Click Sort By: not found. Trying
// another way."), and the step that goes next says what it does instead. Each recovery line is logged `overlay:line`, beside
// the step's `screen:step ok:false`, so the rig can time the one against the other.
import { recoveryLine } from '@sundial/kernel/voice-lines.js'

/** Chats remembered (each its newest step only), the oldest dropped first. */
const CHATS_KEPT = 20

/** `push(session, frame)` sends to that chat's streams. */
export function mountSlipSteps(ctx, push) {
  const last = new Map()
  const keep = (session, row) => {
    last.delete(session)
    last.set(session, row)
    if (last.size > CHATS_KEPT) last.delete(last.keys().next().value)
  }
  const told = (session, stepId, line, reason) =>
    void Promise.resolve(ctx.gnomonKernel?.appendSignal?.('overlay:line', { session, stepId, line, refused: reason })).catch(() => {})
  ctx.effect(() =>
    ctx.on('gnomon/step-line', ({ session, stepId, next, refused } = {}) => {
      if (typeof session !== 'string' || session === '') return
      const was = last.get(session)
      const id = String(stepId ?? '')
      if (refused && typeof refused === 'object') {
        const line = recoveryLine(refused, was?.stepId === id ? was.line : '')
        keep(session, { stepId: id, line: was?.stepId === id ? was.line : '', refused })
        push(session, { type: 'step', line, stepId: id })
        return told(session, id, line, String(refused.reason ?? 'unknown'))
      }
      if (typeof next !== 'string' || next === '') return
      keep(session, { stepId: id, line: next })
      if (!was?.refused) return void push(session, { type: 'step', line: next, stepId: id })
      const line = recoveryLine(was.refused, was.line, next)
      push(session, { type: 'step', line, stepId: id })
      told(session, id, line, String(was.refused.reason ?? 'unknown'))
    }),
  )
  // A refusal is recovered within its turn: the next turn's first step is not "instead" of anything.
  ctx.effect(() => ctx.on('session/event', (session, event) => void (event?.type === 'turn/end' && last.delete(session?.id))))
}
