// The board's live strip: every owner thread with a turn running now, and its newest step.
//
// Fed from the same `session/event` stream the watch reads, for every thread at once, so the owner can
// follow a test run (or several) from whichever thread they have open. Every line is a value already on
// the record: a tool's own name and arguments through `toolLine`, or the first words Gnomon said.
//
// Named exports only.
import { doneFrame, isOwnerMessage, parseLoose, textOf } from '../shell/frames.js'
import { toolLine } from '../shell/tool-line.js'

const clip = (text, max) => {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The threads that are the owner's: the conversation and the ones made here. A helper's own session is not. */
export const ownerThread = (id, companion) => id === companion || (typeof id === 'string' && id.startsWith('session-'))

/** What one event changes on its thread's run, or null. */
function changeOf(event, data) {
  if (event?.type === 'turn/start') return {}
  if (event?.type === 'user/message' && isOwnerMessage(data)) return { title: clip(textOf(data), 72) || null }
  if (event?.type === 'tool/call' && typeof data.name === 'string' && data.name !== '') {
    const { verb, detail } = toolLine(data.name, parseLoose(data.arguments) ?? {})
    return { step: detail ? `${verb} · ${detail}` : verb }
  }
  const said = event?.type === 'assistant/message' ? clip(textOf(data.message), 80) : ''
  return said !== '' ? { step: said } : null
}

/**
 * One logged event of an owner thread → the strip's `run` frame, or null when it moves nothing.
 * `runs` (id → frame) holds every turn running now; a `turn/end` takes its thread out and says how it ended.
 */
export function runFrame(runs, id, event, now = Date.now()) {
  const data = event?.data ?? {}
  const run = runs.get(id)
  if (event?.type === 'turn/end') {
    if (run === undefined) return null
    runs.delete(id)
    return { ...run, done: doneFrame(data).reason }
  }
  const change = changeOf(event, data)
  if (change === null) return null
  const next = { type: 'run', id, since: run?.since ?? now, title: run?.title ?? null, step: run?.step ?? null, done: null, ...change }
  runs.set(id, next)
  return next
}
