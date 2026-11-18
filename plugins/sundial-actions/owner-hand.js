// Set 2 R4: the owner's hand wins, and so do their words. Before each screen act, perform() asks this.
//   - The owner's last key or click under 2 s old holds the act, up to 6 s for a quiet gap; then the chain stops without acting.
//   - A correction the owner sent into this chat after the call began (`task.corrected`, task-boundary) stops it at once.
// Set 3 R5: the last key or click is the newest of the fold's `lifeEvent.idle.ownerHandAt` (idle-track, learned when a ~10 s
// input row lands) and the input helper's own file, read at each check: its `lastKeyAt`/`lastClickAt` are hardware-only
// (macos-input-helper.swift `isHardware`, the HID system's source state), so Gnomon's acts, posted from a private source,
// never count, and a key the owner pressed a second ago is seen before its window lands.
import { readFileSync } from 'node:fs'
import { getInputActivityJsonPath } from '@sundial/helpers/sundial-paths.js'
import { taskOf } from '@sundial/helpers/task-of.js'

export const HAND_MS = 2000
export const WAIT_MS = 6000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The input helper's last hardware key or click (ISO), or null: no file, an older helper (no `ownerOnly`), no key yet. */
export function helperHandAt(file = getInputActivityJsonPath()) {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'))
    if (p.ownerOnly !== true) return null
    const times = [p.lastKeyAt, p.lastClickAt].filter((t) => typeof t === 'string' && Number.isFinite(Date.parse(t)))
    return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  } catch {
    return null
  }
}

/** The correction the running turn has not acted on yet: in this session, folded at or after `since` (ms). */
export function correctionFor(state, session, since) {
  const c = (session ? taskOf(state, String(session)) : state?.task)?.corrected
  return c && since !== undefined && (!session || c.session === String(session)) && Date.parse(c.at) >= since ? c : null
}

/**
 * Null when the act may go now; else `{ refused, reason }`, the step's refusal: `corrected` or `owner-hand`.
 * `onHold(true)` once when the hand starts holding the act, `onHold(false)` once when that hold ends (the act goes or is refused):
 * the moment the slip says "Waiting: your hands are on the keys." (server.js pushes it as a `step` frame with `hand`).
 */
export async function ownerHand(getState, { since, session, now = Date.now, wait = sleep, quietMs = HAND_MS, waitMs = WAIT_MS, handAt = helperHandAt, onHold = () => {} } = {}) {
  const end = now() + waitMs
  const hold = { on: false }
  try {
    for (;;) {
      const c = correctionFor(getState(), session, since)
      if (c) return { refused: `refused: the owner just said ${JSON.stringify(c.text)}. Nothing more was done: follow that over the earlier goal.`, reason: 'corrected' }
      const last = Math.max(...[getState()?.lifeEvent?.idle?.ownerHandAt, handAt()].map((t) => Date.parse(t ?? '')).filter(Number.isFinite))
      const left = quietMs - (now() - last)
      if (!(left > 0)) return null
      if (now() + left > end) return { refused: 'refused: the owner is using the Mac; paused. Nothing more was done: wait for them to stop, or ask.', reason: 'owner-hand' }
      if (!hold.on) (hold.on = true), onHold(true)
      await wait(Math.min(left, 250))
    }
  } finally {
    if (hold.on) onHold(false)
  }
}
