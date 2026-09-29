// One projection of a session's events onto the frames Gnomon's own client
// draws — used for BOTH the live stream and the replay of history.
//
// This file is the reason the client can be plain HTML and JavaScript rather
// than a plugin inside dsh's module loader. dsh's own web app renders a session
// by owning the whole React tree; Gnomon renders one by reading the same
// append-only log through a projection it owns. The log is the contract, and it
// is a very stable one — `SessionEventMap` is the harness's durable format, not
// its UI.
//
// Live and replay are deliberately DIFFERENT projections of the same events,
// not one function with a flag:
//
//   live   — `agent/assistant-stream` chunks, token by token, because a turn in
//            flight should read the way it is being produced. Transient: dsh
//            publishes them process-locally and never writes them to the log.
//   replay — `assistant/message`, the assembled text for a step, because
//            re-deriving a paragraph from four hundred deltas is work that has
//            already been done and stored.
//
// Both emit the same frame VOCABULARY, so the client has one renderer.

/**
 * The wire hands a tool's json argument over as the model's unparsed JSON
 * string. Tolerant on purpose: a truncated call is a real thing that happens
 * mid-stream, and it should draw as an unfinished surface rather than throw.
 */
export function parseLoose(value) {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** The tool whose call IS a surface. Everything else draws as a work row. */
export const SURFACE_TOOL = 'show_surface'

/** Flatten a message's content blocks to their text, ignoring everything else. */
export function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * A `tool/call` event as either a surface frame or a work row.
 *
 * Shared by both projections because a surface is a surface whether it is
 * arriving now or being read back from last Tuesday.
 */
function toolFrame(data) {
  const name = typeof data.name === 'string' ? data.name : ''
  if (name === '') return null
  const callId = String(data.callId ?? '')
  // The arguments travel with every call, not only a surface's: the owner
  // should be able to see WHAT was asked of a tool — for a shell command that
  // is the whole story — and until this they saw only the tool's name.
  const args = parseLoose(data.arguments) ?? {}
  if (name !== SURFACE_TOOL) return { type: 'tool', callId, name, args }
  return {
    type: 'surface',
    callId,
    kind: typeof args.kind === 'string' ? args.kind : '',
    title: typeof args.title === 'string' ? args.title : 'Untitled surface',
    because: typeof args.because === 'string' ? args.because : null,
    args,
  }
}

/**
 * The call id of a `tool/result`, which lives on the result BLOCK and not on
 * the event. Reading the event's own field matched every row against the empty
 * string, so none of them ever closed — the defect is worth naming here because
 * both projections would otherwise repeat it.
 */
/** A result's text is shown to the owner too, so it is bounded: the model saw all of it, the canvas shows this much. */
export const RESULT_TEXT_MAX = 8000

/**
 * The model's plan (`todo_write`): the WHOLE list each time, so the frame
 * carries the whole list and the client replaces rather than patches. Shape is
 * re-established here — the log is durable, the tool's validation is not.
 */
function todoFrame(data) {
  const todos = Array.isArray(data.todos) ? data.todos : []
  return {
    type: 'todo',
    todos: todos
      .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
      .map((item) => ({ content: item.content, status: item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending' })),
  }
}

function resultFrame(data) {
  const block = Array.isArray(data.message?.content) ? data.message.content[0] : null
  const full = textOf(block)
  const text = full.length > RESULT_TEXT_MAX ? `${full.slice(0, RESULT_TEXT_MAX)}\n… (${full.length - RESULT_TEXT_MAX} more characters)` : full
  return { type: 'tool-done', callId: String(block?.toolCallId ?? ''), failed: data.error !== undefined || block?.isError === true, text }
}

/**
 * Files Gnomon is handing over (`deliverables/presented`, from dsh's `present`
 * tool).
 *
 * Built from the DURABLE event rather than from the tool call's arguments,
 * which also carry the paths. dsh appends this event only after a successful
 * present, having checked through the sandboxed `ctx.fs` that every path is an
 * existing regular file — so this is the record of what was actually
 * delivered, and it is the same record the download route checks a request
 * against. One authority for both, so the card can never offer a path the
 * route will refuse.
 *
 * The `present` tool's own row is left in place beside the card. It is
 * slightly redundant when the call succeeds, and it is the only thing the
 * owner sees when it does NOT — a present that failed on a missing file has no
 * durable event and would otherwise be silent.
 *
 * Nothing is copied: dsh's contract is that the owner opens the file where it
 * sits, so the name is all the client can know without reading it.
 */
function deliverableFrame(data) {
  const files = Array.isArray(data.files) ? data.files : []
  return {
    type: 'deliverable',
    callId: String(data.callId ?? ''),
    files: files
      .filter((file) => file !== null && typeof file === 'object' && typeof file.path === 'string' && file.path.trim() !== '')
      .map((file) => ({
        path: file.path,
        // The basename is the name a human reads; the full path is the tooltip.
        name: file.path.split('/').filter(Boolean).pop() ?? file.path,
        description: typeof file.description === 'string' && file.description.trim() !== '' ? file.description.trim() : null,
      })),
  }
}

/**
 * Whether a `user/message` is something the OWNER typed.
 *
 * `source.kind` tells a human prompt apart from an injected context block — a
 * notice, a skill, a file-change notification, the place caption the Ask layer
 * attaches. Injected context is real and is model-visible, but drawing it as
 * the owner's own words would put sentences in their mouth.
 */
export function isOwnerMessage(message) {
  const kind = message?.source?.kind
  return kind === undefined || kind === 'user' || kind === 'human'
}

/**
 * LIVE: one model-stream publication → the frames to push down an open stream.
 *
 * Reasoning is announced but never transcribed. The owner asked a question, not
 * for a recording of the model having second thoughts about it — and on a local
 * model that text is most of the tokens.
 *
 * The deltas used to arrive as an `assistant/chunk` SESSION event, which dsh
 * 0.1.5 retired: a streamed chunk is transient, so it is no longer written to
 * the durable log at all. It now arrives on `agent/assistant-stream` as
 * `{ type: 'chunk', chunk }` — the same `StreamChunk` in a new envelope. When
 * the old branch stopped matching, a turn streamed nothing, the shell's
 * empty-turn guard fired, and a turn that had actually answered was reported to
 * the owner as "the model produced nothing". The answer was in the log the
 * whole time; only the live paint was missing.
 */
export function streamFrames(frame) {
  if (frame?.type !== 'chunk') return []
  const chunk = frame.chunk ?? {}
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') return [{ type: 'text', delta: chunk.text }]
  if (chunk.type === 'reasoning-delta') return [{ type: 'thinking' }]
  return []
}

/**
 * LIVE: one session event → the frames to push down an open stream.
 *
 * Everything here is durable. The model's own prose comes from
 * {@link streamFrames} instead.
 */
export function liveFrames(event) {
  const type = event?.type
  const data = event?.data ?? {}

  if (type === 'user/message') {
    // The owner's own turn, echoed back from the log rather than trusted from
    // the client — so a second window watching the same session sees it too.
    if (isOwnerMessage(data)) return [{ type: 'user', text: textOf(data) }]
    const brought = broughtFrame(data)
    return brought === null ? [] : [brought]
  }
  if (type === 'tool/call') {
    const frame = toolFrame(data)
    return frame === null ? [] : [frame]
  }
  if (type === 'tool/result') return [resultFrame(data)]
  if (type === 'todo/write') return [todoFrame(data)]
  if (type === 'deliverables/presented') return [deliverableFrame(data)]
  if (type === 'turn/end') return [doneFrame(data)]
  return []
}

/**
 * Why a turn ended, from dsh's tagged `TurnEndReason`.
 *
 * It is an OBJECT — `{ kind: 'aborted', reason: { kind: 'user' } }` — and this
 * read it with `typeof reason === 'string'`, which is never true, so every turn
 * was reported as `complete` however it actually ended. The client's own "the
 * turn ended without an answer" branch could not fire, and a turn the owner
 * stopped looked exactly like one that finished.
 *
 * `completed` is normalised to `complete`: that string is what the client and
 * the shell's empty-turn guard already test against.
 */
export function doneFrame(data) {
  const reason = data?.reason
  if (typeof reason === 'string') return { type: 'done', reason }
  const kind = reason?.kind
  if (kind === undefined || kind === 'completed') return { type: 'done', reason: 'complete' }
  // WHO stopped it. `user` is the owner pressing Stop; `parent`, `hook` and
  // `disposed` are the machine, and they should never read as the owner's doing.
  if (kind === 'aborted') return { type: 'done', reason: 'aborted', by: reason.reason?.kind ?? 'unknown' }
  if (kind === 'error') return { type: 'done', reason: 'error', message: typeof reason.error?.message === 'string' ? reason.error.message : null }
  return { type: 'done', reason: kind }
}

/**
 * REPLAY: a session's whole log → the frames that redraw it.
 *
 * Ordered by the log, which is the only order that is true. A turn is a
 * boundary rather than a container: the client groups on `turn` frames, so a
 * transcript can be streamed in and appended to without ever holding a tree.
 */
/**
 * A thread the owner brought into the conversation: the digest rides in as a
 * plugin notice whose summary starts "Brought in:", and the transcript marks
 * the spot with the thread's name (live and on replay alike).
 */
const BROUGHT = /^Brought in: /
function broughtFrame(data) {
  const summary = data?.source?.summary
  return data?.source?.kind === 'plugin' && typeof summary === 'string' && BROUGHT.test(summary) ? { type: 'brought', title: summary.replace(BROUGHT, '') } : null
}

export function replayFrames(events) {
  const frames = []
  for (const event of events ?? []) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        frames.push({ type: 'turn', turn: data.turn })
        break
      case 'user/message': {
        if (isOwnerMessage(data)) frames.push({ type: 'user', text: textOf(data) })
        const brought = broughtFrame(data)
        if (brought !== null) frames.push(brought)
        break
      }
      case 'assistant/message': {
        const text = textOf(data.message)
        // An assistant step that only called tools has no prose, and an empty
        // paragraph in a transcript reads as a failure rather than as a step
        // that did its talking with a tool.
        if (text.trim() !== '') frames.push({ type: 'say', text })
        break
      }
      case 'tool/call': {
        const frame = toolFrame(data)
        if (frame !== null) frames.push(frame)
        break
      }
      case 'tool/result':
        frames.push(resultFrame(data))
        break
      case 'turn/end':
        frames.push(doneFrame(data))
        break
      case 'todo/write':
        frames.push(todoFrame(data))
        break
      case 'deliverables/presented':
        frames.push(deliverableFrame(data))
        break
      default:
        break
    }
  }
  return frames
}

/**
 * The last `keep` turns of a replay, and how many turns came before them.
 *
 * The conversation is one long session, and opening it replayed all of it:
 * measured on the record, 211 turns and 24 compactions in a 17 MB log, redrawn
 * on every open. The page draws the recent turns and an "Earlier" fold that
 * asks for the rest. The cut is on a turn's first frame, so a tool call and its
 * result are never split.
 */
export function recentTurns(frames, keep) {
  const starts = []
  frames.forEach((frame, i) => {
    if (frame.type === 'turn') starts.push(i)
  })
  if (starts.length <= keep) return { frames, earlier: 0 }
  return { frames: frames.slice(starts[starts.length - keep]), earlier: starts.length - keep }
}

/**
 * A session's title for the list, in the order the truth is knowable.
 *
 * A title the caller already holds wins. Failing that, dsh's own title is read
 * from the log itself — `session/title` is latest-wins and log-only — and
 * failing THAT, the first thing the owner said is a better name than the id: a
 * list of `session-<uuid>` is a list nobody can navigate.
 *
 * Reading the title event here is what lets ONE pass over a session's events
 * answer the whole question. It used to take two round trips per session (a
 * title read, then a full log read when that came back empty), which is the
 * shape that made the sidebar cost four seconds.
 */
export function titleFrom(events, fallbackTitle) {
  const title = typeof fallbackTitle === 'string' ? fallbackTitle.trim() : ''
  if (title !== '') return title
  let logged = ''
  let firstSaid = ''
  for (const event of events ?? []) {
    if (event?.type === 'session/title') {
      const text = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
      // Latest-wins: keep overwriting rather than breaking on the first.
      if (text !== '') logged = text
      continue
    }
    if (firstSaid !== '') continue
    if (event?.type !== 'user/message') continue
    if (!isOwnerMessage(event.data)) continue
    const text = textOf(event.data).trim().replace(/\s+/g, ' ')
    if (text !== '') firstSaid = text.length > 72 ? `${text.slice(0, 71)}…` : text
  }
  return logged !== '' ? logged : firstSaid
}
