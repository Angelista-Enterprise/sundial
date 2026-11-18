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
import { uncursored } from './answer-only.js'
import { SILENT_CODE, SILENT_LINE } from '../sundial-llm-openai/stall.js'

const OWNER_MAX = 1200
const SAID_MAX = 2000
const TOOLS_MAX = 20
/**
 * A reply that says it did a final in this turn: "I sent it", "I've discarded", "Sent." at a sentence's start, or a whole
 * sentence "The draft was discarded." Not a report about someone else or another day ("nothing was sent", "the invite was
 * sent by Mira", "your PR was submitted Monday"). And the tools that could have done one.
 */
const DONE = '(sent|discarded|deleted|submitted|posted|removed|trashed)'
const FINAL_CLAIM = new RegExp(String.raw`\bI(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|already\s+)?${DONE}\b|(?:^|[.!?]\s+)${DONE}(?=[.!:,]|\s+(?:to|it|them)\b|\s*$)|(?:^|[.!?]\s+)the(?:\s+[\w'’-]+){1,4}\s+(?:was|were|has been|have been)\s+${DONE}(?=\s*[.!]|\s*$)`, 'im')
const ACTS = /^(screen_act|screen_undo|web_act|gnomon_run_shell|bash|gnomon_skill|gnomon_calendar_create|gnomon_reminder_create|mcp__.+)$/

/**
 * Set 4 R1 (runs 211, 212 T18): "the owner's hand wins: Gnomon stops at once and says where it stopped" (doc 14). A Stop ends the
 * turn with no reply of its own, so the record had no answer and the owner no word of what was done. The turn's said row is then
 * this line, from the task's own steps (the task object, `taskBoundary`): what was done before the stop, and what was refused.
 */
export function stopLine(task, set = []) {
  // Run 253 T18: a rename the Stop caught after its new name went in is done, whatever its refused step line says.
  const went = (line) => set.find((name) => line.startsWith(`rename ${JSON.stringify(name)} `) && OWNER_STOP.test(line))
  const did = [...(task?.did ?? []), ...(task?.failed ?? []).filter(went).map((line) => `${line.replace(OWNER_STOP, '')} (its new name went in as the stop came)`)]
  const failed = (task?.failed ?? []).filter((line) => !went(line))
  return [
    did.length ? `Stopped, as you asked. Done before the stop (${did.length} ${did.length === 1 ? 'step' : 'steps'}): ${did.join('; ')}.` : 'Stopped, as you asked, before any step was done.',
    failed.length ? `Refused before it: ${failed.join('; ')}.` : null,
    'Nothing after that ran.',
  ].filter(Boolean).join(' ')
}
const OWNER_STOP = /: refused, owner-(moved|hand)$/

/**
 * Run 253 T18 (doc 30): the Stop's own click refused the Return that commits a rename, after the act that set the new name
 * performed; Finder kept the name through the Escape (as in run 219), so the disk held 3 and the line said 2. From the chat's
 * acts (`screen:asked` names the chat, `screen:acted` the outcome): the old names of the renames the owner's hand refused after
 * a performed set-value replaced the name. `rows`: the log's screen rows since the turn began, oldest first.
 */
export function namesSet(rows, sessionId) {
  const mine = new Set()
  const out = []
  const name = { set: false }
  for (const { signalType, eventType, data: d = {} } of rows ?? []) {
    const type = `${signalType}:${eventType}`
    if (type === 'screen:asked' && d.session === sessionId) mine.add(d.id)
    else if (type === 'screen:acted' && mine.has(d.id) && d.outcome === 'performed' && d.replacedChars > 0) name.set = true
    else if (type === 'screen:step' && d.session === sessionId) {
      if (name.set && d.verb === 'rename' && d.ok === false && /^owner-(moved|hand)$/.test(d.reason) && d.screenText?.[0]) out.push(d.screenText[0])
      name.set = false
    }
  }
  return out
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
/** The step a Stop caught mid-way lands with its after-look: the line waits until the task's lines hold still, 8 times 500 ms at most. */
const SETTLE_MS = 500
const SETTLE_TRIES = 8

/**
 * @param {{ appendSignal: Function, log?: Function, warn?: Function, taskOf?: (sessionId: string) => object | null, screenRows?: (since: string) => Promise<object[]>, show?: Function, wait?: (ms: number) => Promise<void> }} deps
 *   `taskOf`: the chat's task object (its steps), for the line a Stop ends a turn with; `screenRows(sinceIso)`: the log's
 *   screen:asked, screen:acted and screen:step rows since then (namesSet); `show`: that line on the slip.
 * @returns {(session: { id?: string, header?: { origin?: string } } | undefined, event: { type?: string, time?: number, data?: any } | undefined) => void}
 */
export function createRouteLog({ appendSignal, log = console.log, warn = console.warn, taskOf = () => null, screenRows = async () => [], show = () => {}, wait = sleep }) {
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
      turns.set(sessionId, { ...(turns.get(sessionId) ?? { texts: [], tools: new Set() }), turnId, since: at })
      const images = Array.isArray(data.content) ? data.content.filter((b) => b?.type === 'image').length : 0
      void record('chat:owner', { sessionId, turnId, text: text.slice(0, OWNER_MAX), chars: text.length, images }, at)
      return
    }
    // A turn nobody typed (a notice waking the conversation, a job) is recorded too.
    const turn = turns.get(sessionId) ?? { turnId: null, texts: [], tools: new Set() }
    if (type === 'assistant/message') {
      // Run 250 T19: a stopped stream's lone "█" is no word. Run 251 T19: a line said with a tool call ("Now set the filename field
      // and save.") is the step's narration, not the answer: the answer row is the lines said with none, when there are any.
      const text = uncursored(textOf(data.message)).trim()
      const narration = Array.isArray(data.message?.content) && data.message.content.some((b) => b?.type === 'tool-call')
      if (text !== '') turns.set(sessionId, { ...turn, texts: [...turn.texts, text], ...(narration ? {} : { finals: [...(turn.finals ?? []), text] }) })
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
      const tools = [...turn.tools]
      // The owner's Stop: the turn's answer says where it stopped, once the step it caught has landed.
      if (data.reason?.kind === 'aborted' && data.reason.reason?.kind === 'user') {
        void (async () => {
          const lines = () => JSON.stringify(taskOf(sessionId) ?? null)
          for (let i = 0; i < SETTLE_TRIES; i++) {
            const seen = lines()
            await wait(SETTLE_MS)
            if (lines() === seen) break
          }
          const rows = await Promise.resolve(screenRows(turn.since ?? new Date(Number(event.time ?? Date.now()) - 15 * 60_000).toISOString())).catch(() => [])
          const line = stopLine(taskOf(sessionId), namesSet(rows, sessionId))
          const text = [...turn.texts, line].join('\n\n')
          show({ sessionId, line })
          await record('chat:said', { sessionId, turnId: turn.turnId ?? `${sessionId}#${data.turn ?? ''}`, text: text.slice(0, SAID_MAX), chars: text.length, tools, stopped: true }, at)
        })()
        return
      }
      // Run 250 T04 (doc 30): the 90 s cap (or the silent stall) ended the turn with no word, so no answer row, and the rig
      // waited 93 s more for one. Its line is the answer.
      const silent = turn.texts.length === 0 && data.reason?.kind === 'error' && data.reason.error?.code === SILENT_CODE
      const text = silent ? SILENT_LINE : (turn.finals ?? turn.texts).join('\n\n')
      log(`[sundial-tools] chat recorder: ${sessionId} turn ${data.turn ?? '?'} said ${text.length} chars, ${tools.length === 0 ? 'no tools' : tools.map((t) => t.replace(/^gnomon_/, '')).join(',')}`)
      if (text === '') return
      const turnId = turn.turnId ?? `${sessionId}#${data.turn ?? ''}`
      void record('chat:said', { sessionId, turnId, text: text.slice(0, SAID_MAX), chars: text.length, tools }, at)
      // One run answered "The draft was discarded" with no tool in the turn, an earlier turn's answer repeated. Not
      // blocked: a claimed final with no act in its turn goes on the record for self-review.
      const claim = FINAL_CLAIM.exec(text)?.slice(1).find(Boolean)?.toLowerCase()
      if (claim && !tools.some((tool) => ACTS.test(tool))) void record('review:unbacked-claim', { sessionId, turnId, claim, tools }, at)
    }
  }
}
