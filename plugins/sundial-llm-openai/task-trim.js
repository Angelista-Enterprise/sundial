// Set 4 R1: a chat call's history, cut where the cut pays (Fable M2, measured by lab/screen-rig/review/task-replay.mjs).
//
// Run 208 paid 1.26M prompt tokens for 10 tasks. Most of every prompt was cached, though: the provider caches a prefix in
// 512-token blocks, and on runs 207 to 210 it delivered 100% of what that block model calls cacheable. So a cut is worth
// what it saves in cached tokens, less what it costs in fresh ones (a fresh token also slows the first token: llm_audit
// fits 934 ms + 30.5 ms per 1k fresh). Cuts on the history the provider sees, never on the session log:
// - a settled turn (one that ended on a reply) keeps the owner's words, its reply, and what stands in its brief (the
//   memory, the owner's apps, the routes: the parts a later brief leaves out as given). Its tool calls and results go,
//   and so does the part of its brief that only held for that turn: from its clock line on (the present, the stance, the
//   reply rules), which the turn in flight's own brief says again, and any block a later brief sends again whole (the
//   board's cards, an app's routes). Over runs 207 to 210 the briefs were half of every prompt; tool results were 8%.
//   The next turn's brief prints the settled task's object (turn-brief.ts `taskLines(task, 'last')`).
// - `keep` (default on): a settled turn keeps its last call and result when its reply is shorter than that result: the
//   reply did not carry what was found, and "and the other one?" needs it.
// - the turn in flight is left whole by default (`inflight: 'whole'`): each step's prompt extends the one before. The
//   `cut` variant put the task object in place of its earlier calls; it saved no more and made each step's tail fresh.
// - a failed step in the turn in flight: `RECOVERY_RULE` rides last, as its own message, never inside a data block.
//
// task-replay.mjs, per task on runs 207 to 210 (n 40; cost with cached tokens at 0.1 / 0.25 of a fresh one, first token):
//   today 94.5k in, 7.7k fresh, 1.00x / 1.00x, 997 ms a call
//   cut (R1) 74.1k, 8.2k fresh, 0.90x / 0.84x, 1001 ms;  cut + keep 77.0k, 8.6k, 0.94x / 0.87x, 1005 ms
//   whole 75.3k, 8.1k, 0.90x / 0.85x, 1000 ms;          whole + keep (default) 78.2k, 8.6k, 0.95x / 0.88x, 1004 ms
// The two cheapest drop a settled search the next turn needs (task-trim.test.js, the follow-up case); of the two that keep
// it, whole + keep is as cheap within 0.01x and never cuts the turn that is running.
//
// Named exports only.
import { RECOVERY_RULE, taskLines } from '@sundial/kernel/turn-brief.js'

const calls = (m) => m?.role === 'assistant' && (m.content ?? []).some((b) => b?.type === 'tool-call')
const words = (m) => ({ ...m, content: (m.content ?? []).filter((b) => b?.type === 'text' && String(b.text ?? '').trim() !== '') })
/** The theme's brief (host/server.js `briefMessage`), and its clock line (ask-prompt.ts `nowLine`), where the turn's own part starts. */
const BRIEF = 'sundial-shell'
const CLOCK = /^Right now it is /m
/** A line that starts a block of a brief: not indented, not a list item, not a quote. Its first line names the block. */
const OPENS = /^(?![\s\-•*"“]|\d+[.)]\s)/
const textOf = (m) => (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
function blocksOf(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (out.length === 0 || (line.trim() !== '' && OPENS.test(line))) out.push([line])
    else out.at(-1).push(line)
  }
  return out
}
/**
 * A settled turn's brief: up to its clock line, without the blocks a later brief sends again (the same first line: the board's
 * cards, an app's learned routes, re-sent whole whenever one row of them changes). Null when nothing is left.
 */
function standing(m, later) {
  const text = textOf(m)
  const at = text.search(CLOCK)
  const kept = blocksOf(at < 0 ? text : text.slice(0, at)).filter((b) => !later.has(b[0].trim())).map((b) => b.join('\n')).join('\n').trim()
  return kept === '' ? null : { ...m, content: [{ type: 'text', text: kept }] }
}

/** True when the task object holds a step. */
export const holds = (task) => Boolean(task) && ['known', 'did', 'failed', 'open'].some((k) => (task[k]?.length ?? 0) > 0)

/**
 * The variants task-replay.mjs measured (Fable M2). `keep`: a settled turn keeps its last call and result when its reply is
 * shorter than that result (the reply did not carry what was found, and a follow-up may need it). `inflight`: `cut` puts the
 * task object in place of the turn's earlier calls; `whole` leaves the turn in flight as it is, so each step's prompt
 * extends the one before and stays cached.
 */
export const TRIM = { keep: true, inflight: 'whole' }

const resultText = (m) => (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
const callIds = (m) => new Set((m.content ?? []).filter((b) => b?.type === 'tool-call').map((b) => b.id))

/** Per settled turn, the messages of its last call to keep whole: that call and its results, when its reply is shorter. */
function keptCalls(list, settled) {
  const keep = new Set()
  const replies = list.slice(0, settled + 1).map((m, i) => (m?.role === 'assistant' && !calls(m) ? i : -1)).filter((i) => i >= 0)
  for (const [n, r] of replies.entries()) {
    const from = n === 0 ? 0 : replies[n - 1] + 1
    const lc = list.slice(from, r).findLastIndex(calls)
    if (lc < 0) continue
    const at = from + lc
    const ids = callIds(list[at])
    const results = list.slice(at + 1, r).map((m, i) => [at + 1 + i, m]).filter(([, m]) => m.role === 'tool' && ids.has(m.toolCallId))
    if (resultText(list[r]).length < results.reduce((sum, [, m]) => sum + resultText(m).length, 0)) for (const i of [at, ...results.map(([i]) => i)]) keep.add(i)
  }
  return keep
}

/** `messages` (dsh's, before serializing) with the cuts; `task` is this chat's task (`state.tasks`, helpers `taskOf`), or null for no task object. */
export function trimSteps(messages, task, { keep = TRIM.keep, inflight = TRIM.inflight } = {}) {
  const list = Array.isArray(messages) ? messages : []
  // An older (V3) log carries a tool result inside a user message: left as it is.
  if (list.some((m) => m?.role === 'user' && (m.content ?? []).some((b) => b?.type === 'tool-result'))) return list
  // A turn ends on a reply: an assistant message with no tool call. What follows the newest one is the turn in flight.
  const settled = list.findLastIndex((m) => m?.role === 'assistant' && !calls(m))
  const whole = keep ? keptCalls(list, settled) : new Set()
  // Newest first, so each settled brief knows the blocks every later brief holds.
  const later = new Set()
  const briefs = new Map()
  for (const [i, m] of [...list.entries()].reverse()) {
    if (m?.role !== 'user' || m.source?.kind !== BRIEF) continue
    if (i <= settled) briefs.set(i, standing(m, later))
    for (const b of blocksOf(textOf(m))) later.add(b[0].trim())
  }
  const out = []
  for (const [i, m] of list.slice(0, settled + 1).entries()) {
    if (whole.has(i)) out.push(m)
    else if (m.role === 'tool') continue
    else if (briefs.has(i)) {
      if (briefs.get(i)) out.push(briefs.get(i))
    } else if (!calls(m)) out.push(m)
    else if (words(m).content.length > 0) out.push(words(m))
  }
  const turn = list.slice(settled + 1)
  const last = turn.findLastIndex(calls)
  // A failed step in this turn: the rule to name it rides last, apart from the task object's data (Fable L3).
  const rule = last >= 0 && holds(task) && (task.failed?.length ?? 0) > 0 ? [{ role: 'user', content: [{ type: 'text', text: RECOVERY_RULE }], source: { kind: 'sundial-task' } }] : []
  // Nothing before the last call to stand in for: the object would only add (run 210's pull-up, 2 steps).
  if (inflight === 'whole' || !holds(task) || last < 0 || !turn.slice(0, last).some(calls)) return [...out, ...turn, ...rule]
  const note = { role: 'user', content: [{ type: 'text', text: taskLines(task, 'now') }], source: { kind: 'sundial-task' } }
  return [...out, ...turn.slice(0, last).filter((m) => m.role !== 'tool' && !calls(m)), note, ...turn.slice(last), ...rule]
}
