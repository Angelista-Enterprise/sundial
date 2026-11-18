// What a tool call is doing, in the owner's words.
//
// A row used to read `today_summary` and nothing else: the owner saw that
// something ran, never what it was asked or what came back. This turns a call
// into one line ("Reading the day · 2026-09-22") and a result into a few words
// ("14 results", "failed: no such file"). Pure, so the test pins the wording.
//
// Named exports only.

const clip = (text, max = 48) => {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
const quoted = (text) => `“${clip(text, 40)}”`
const humanize = (name) => name.replace(/^gnomon_/, '').replace(/[_-]+/g, ' ')

/** name → (args) => [verb phrase, detail or null]. */
const PHRASES = {
  gnomon_today_summary: (a) => ['Reading the day', a.date ?? null],
  gnomon_code_activity: (a) => ['Reading commits and edits', a.date ?? a.project ?? null],
  gnomon_signals: (a) => ['Reading raw signals', a.type ?? a.date ?? null],
  gnomon_semantic_search: (a) => ['Searching memory', a.query ? quoted(a.query) : null],
  gnomon_entity_history: (a) => ['Looking up', a.name ?? null],
  gnomon_open_commitments: () => ['Checking open threads', null],
  gnomon_moment_detail: (a) => ['Opening a moment', a.momentId ?? null],
  gnomon_recent_activity: () => ['Reading recent activity', null],
  gnomon_current_context: () => ['Checking what you are doing', null],
  gnomon_people: () => ['Reading the people roster', null],
  gnomon_routines: () => ['Reading your routines', null],
  gnomon_anomalies: () => ['Looking for anything unusual', null],
  gnomon_goals: () => ['Reading goals', null],
  gnomon_project_status: (a) => ['Reading project status', a.project ?? null],
  // lane D
  gnomon_project_handoff: (a) => ['Writing the handoff', a.project ?? null],
  gnomon_tools: () => ['Finding the right tool', null],
  gnomon_look: (a) => ['Reading a card', a.id ?? null],
  gnomon_board: (a) => [BOARD_VERBS[a.action] ?? 'Arranging the board', a.because ?? a.text ?? a.kind ?? null],
  gnomon_assert: (a) => ['Remembering', [a.predicate, a.object].filter(Boolean).join(' ') || null],
  gnomon_propose: (a) => ['Proposing', a.title ?? a.summary ?? null],
  gnomon_record_outcome: () => ['Recording how it went', null],
  gnomon_run_shell: (a) => ['Running', a.command ?? null],
  // run200: "Await · job-0acb1c8e" named the wait by its id. What is waited for, in words.
  gnomon_await: (a) => [a.job ? 'Waiting for the background job' : a.file ? 'Waiting for a file' : a.app ? `Waiting for ${a.app}` : 'Waiting', a.gone ? `until "${a.gone}" is gone` : a.window ?? null],
  gnomon_compose_figure: (a) => ['Drawing a figure', a.title ?? a.kind ?? null],
  gnomon_lens: (a) => ['Building a lens', a.title ?? null],
  gnomon_ask_owner: (a) => ['Asking you', a.question ?? null],
  gnomon_start_job: (a) => [a.repeat ? `Keeping a job, ${a.repeat}` : 'Starting a job', a.subject ?? null],
  gnomon_stop_repeat: (a) => ['Stopping a repeating job', a.subject ?? null],
  gnomon_schedule_wakeup: () => ['Setting a reminder for myself', null],
  gnomon_track_promise: () => ['Keeping track of a promise', null],
  gnomon_reminder_create: () => ['Adding it to Reminders', null],
  gnomon_calendar_create: (a) => ['Adding to your calendar', a.title ?? null],
  gnomon_conversation_search: (a) => ['Searching past chats', a.query ? quoted(a.query) : null],
  web_search: (a) => ['Searching the web', a.query ? quoted(a.query) : null],
  web_fetch: (a) => ['Reading a page', hostOf(a.url)],
  todo_write: () => ['Updating the plan', null],
  skill: (a) => ['Reading how to do it', a.name ?? a.skill ?? null],
  ask_user_question: () => ['Asking you', null],
  subagent: (a) => ['Sending a helper off', a.description ?? a.prompt ?? null],
  send_message: (a) => ['Messaging a helper', a.message ?? null],
  interrupt_agent: () => ['Stopping a helper', null],
  list_agents: () => ['Checking on the helpers', null],
  job_output: () => ['Reading what a helper found', null],
  job_list: () => ['Listing background work', null],
  job_kill: () => ['Stopping background work', null],
  present: () => ['Handing you a file', null],
  screen_look: (a) => ['Looking at', [a.app, a.window].filter(Boolean).join(', ') || 'the app in front'],
  // Without a goal, the app it works in (run202: "Doing a step" read like a log line).
  screen_act: (a) => [a.goal ? capital(String(a.goal)) : a.app ? `Working in ${a.app}` : 'Working on the screen', a.because ?? (Array.isArray(a.steps) ? `${a.steps.length} steps` : [a.action, a.label].filter(Boolean).join(' ') || null)],
  screen_mark: (a) => ['Pointing at it', a.label ?? null],
  screen_guide: (a) => ['Walking you through', a.task ?? null],
  screen_undo: () => ['Putting the old value back', null],
}
const BOARD_VERBS = { place: 'Putting a card on the board', focus: 'Showing you a card', move: 'Moving a card', remove: 'Taking a card off', step: 'Walking you through', walk: 'Laying out a walk-through', clear: 'Clearing the board', note: 'Leaving a note', span: 'Changing the board’s days' }

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return typeof url === 'string' ? clip(url) : null
  }
}

/** One call → `{ verb, detail }`. `gnomon_call` reads as the tool it calls. */
export function toolLine(name, args = {}) {
  const a = args !== null && typeof args === 'object' ? args : {}
  if (name === 'gnomon_call' && typeof a.name === 'string') {
    const inner = typeof a.args === 'string' ? safeParse(a.args) : a.args
    return toolLine(a.name, inner ?? {})
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
  if (mcp) return { verb: `${capital(mcp[1])}: ${humanize(mcp[2])}`, detail: firstString(a) }
  const phrase = PHRASES[name]
  if (phrase) {
    const [verb, detail] = phrase(a)
    return { verb, detail: detail == null || detail === '' ? null : clip(detail) }
  }
  return { verb: capital(humanize(name)), detail: firstString(a) }
}

/** A result → a few words, or null when there is nothing worth saying. */
export function resultGist(text, failed = false) {
  const raw = String(text ?? '').trim()
  if (failed || /^Error:/.test(raw)) return `failed: ${clip(raw.replace(/^Error:\s*/, ''), 70) || 'no reason given'}`
  if (raw === '') return 'nothing came back'
  const parsed = safeParse(raw)
  if (Array.isArray(parsed)) return parsed.length === 0 ? 'nothing found' : `${parsed.length} ${parsed.length === 1 ? 'result' : 'results'}`
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.rows)) return `${parsed.rows.length}${parsed.truncated ? '+' : ''} results`
    const lists = Object.values(parsed).filter(Array.isArray)
    if (lists.length === 1) return lists[0].length === 0 ? 'nothing found' : `${lists[0].length} ${lists[0].length === 1 ? 'result' : 'results'}`
    return null
  }
  // Markup (a loaded skill, a page) says nothing in a few words.
  return raw.startsWith('<') ? null : clip(raw, 70)
}

/** A call's arguments, from the rows drawn by call id. A call made through gnomon_call is drawn under the outer id, holding {name, args}; its own id is `<outer>:<name>`. */
export function callArgs(rows, callId) {
  const id = String(callId ?? '')
  const own = rows.get(id)?._args
  if (own !== undefined || !id.includes(':')) return own
  const inner = rows.get(id.slice(0, id.lastIndexOf(':')))?._args?.args
  return typeof inner === 'string' ? safeParse(inner) ?? undefined : inner
}

/** A call's arguments as readable JSON, bounded, or null when it has none. */
export function argsText(args) {
  if (args === undefined || args === null || (typeof args === 'object' && Object.keys(args).length === 0)) return null
  const text = JSON.stringify(args, null, 2)
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text
}

/** Seconds, the way a person says them: "0.4s", "12s", "2m 5s". */
export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
function firstString(a) {
  const v = Object.values(a).find((x) => typeof x === 'string' && x.trim() !== '')
  return v === undefined ? null : clip(v)
}
function capital(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
