// The work loop's hands: a dedicated `gnomon-work` agent that does one job the
// `workbench` rule opened, and two tools that carry the result back through the
// log.
//
// The rule decides WHEN and WHAT (state only, no model); this file decides HOW:
// it wakes a worker session with the job, the worker reads with the gnomon_*
// tools, searches and fetches the web, reads the owner's connected services,
// and ends the turn with `gnomon_shelve` (something worth keeping) or
// `gnomon_work_done` (nothing was). Both append an ordinary signal
// (`work:shelved` / `work:closed`) that the rule folds — the shelf is a
// knowledge entry, retractable through the same verdict path as everything
// else Gnomon produces.
//
// Read-only by construction: the worker session has no owner watching it, so a
// tool that needs approval would hang the turn. The prompt forbids them and the
// rule's timeout closes a job that hangs anyway.
//
// Named exports only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { redactSecrets } from '@sundial/helpers/llm-error-class.js'
import { chatDefault } from '@sundial/helpers/llm-providers.js'
import { sandboxOf } from '@sundial/helpers/sandbox.js'
import { handPreamble, resolveClaude, runHand } from './claude-hand.js'
import { claudeRuntime, isRuntimeSource, setRuntime } from '@sundial/llm/index.js'

const PLUGIN = 'sundial-proactive'

/**
 * The in-process subagent provider dsh mounts by default
 * (`subagent-spawn-in-process`, `providerName: spawn` — confirmed in the
 * composed profile tree). `fork` is the other one; spawn is right here because
 * a job starts from a brief rather than from a copy of a conversation.
 */
const SUBAGENT_PROVIDER = 'spawn'

/**
 * When a running job is abandoned.
 *
 * MUST match `JOB_TIMEOUT_MS` in packages/rules/src/workbench.ts, which is
 * where the rule gives up on an unreported job and closes it `timed-out`.
 * Duplicated rather than imported: `@sundial/rules` is not a dependency of this
 * plugin and adding one for a single number is a pnpm change for no gain. If
 * they drift, the rule closes the record while the child keeps spending — which
 * is precisely the state this constant exists to end.
 */
const JOB_TIMEOUT_MS = 20 * 60 * 1000

/** The text of a message built by `jobContext`/`jobPrompt`, for a child that takes a prompt rather than a turn. */
function promptText(message) {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}
export const WORK_SESSION_ID = 'gnomon-work'
/** S4: a rig chat's sandbox job: at most this much, never the owner's `jobs.maxUsdPerJob`. */
export const SANDBOX_USD_PER_JOB = 0.25
/** S4: a sandbox job has no tools (the runtime's `tools: 'none'`): no MCP, no web. It answers from the job's text alone. */
const SANDBOX_PREAMBLE = 'This is a test chat\'s job: you have no tools at all. Answer from the job text alone. Wherever the text says to finish with gnomon_shelve or gnomon_work_done, or to load a skill or use a tool, answer in the JSON schema instead: outcome "shelved" with title, body and sources (sources may be empty), or outcome "nothing".'

/**
 * A helper the MODEL starts with dsh's `subagent` tool gets the brief once, as
 * it starts (the clock and the owner's memory, no reply rules): since W1 step 5
 * nothing reaches a child as a system-prompt context, so without this it knew
 * neither the date nor the owner. Sundial's own jobs (children of the work
 * session) carry the brief in their prompt already. The child's first model
 * call may already be under way when `subagent/start` fires; an injected
 * context lands at its next round.
 */
export async function briefSubagent(ctx, info) {
  const child = info?.local ? ctx.agents?.get?.(info.id) : null
  if (!child || child.session?.header?.parentSession === WORK_SESSION_ID) return false
  const told = await Promise.resolve(ctx.gnomonKernel?.brief?.({ sessionId: info.id, cause: { kind: 'work' } })).catch(() => null)
  if (!told) return false
  child.inject(createUserMessage({ content: [{ type: 'text', text: told.text }], source: { kind: PLUGIN, form: 'notice', summary: boundContextSummary(told.present) } }))
  return true
}

/**
 * S4: a helper a RIG chat starts with dsh's `subagent` tool is the rig's too. Its session is new to the record, so the
 * gate would not know it; one `thread:delegate` row names it and its parent, and `rigSessions` marks it when the parent
 * is a rig chat. Nothing is appended for any other helper.
 */
export async function markRigDelegate(ctx, info) {
  const child = info?.local ? ctx.agents?.get?.(info.id) : null
  const parent = child?.session?.header?.parentSession
  if (typeof parent !== 'string' || ctx.gnomonKernel?.getState?.()?.rigSessions?.[parent] === undefined) return false
  await Promise.resolve(ctx.gnomonKernel.appendSignal('thread:delegate', { sessionId: String(info.id), parent })).catch(() => {})
  return true
}

function markerPath(home) {
  return `${home}/.daemon/work-session.json`
}

/** Find-or-create the one worker agent — the same three tiers the companion and the Ask agent use. */
/** The route the work agent and each job's child run on: the chat's own default, read now. */
const workRoute = (ctx) => chatDefault(ctx.agentDefaultModel.currentSelection(), ctx.gnomonKernel?.getState?.()?.config.llm)

export async function ensureWorkAgent(ctx, opts) {
  // Two jobs starting in the same tick both found no agent and both created one; the second failed
  // with "session gnomon-work already exists". One creation at a time, shared by whoever waits.
  if (creating === null) creating = ensureWorkAgentOnce(ctx, opts).finally(() => (creating = null))
  return creating
}
let creating = null
async function ensureWorkAgentOnce(ctx, { home, cwd }) {
  const sessionId = SessionId(WORK_SESSION_ID)
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return { agent: live, resumed: true }

  const selection = workRoute(ctx)
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = async (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    // The Gnomon preset. Children compose FROM this parent, so a job's child
    // gets todo_write (its steps show in the tab) and the skills.
    await ctx.get?.('agentPresets')?.mount(agentCtx, 'gnomon')
  }

  let hasMarker = false
  try {
    hasMarker = typeof JSON.parse(readFileSync(markerPath(home), 'utf8'))?.sessionId === 'string'
  } catch {
    hasMarker = false
  }
  if (hasMarker) {
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      return { agent: handle.agent, resumed: true }
    } catch (error) {
      console.warn(`[${PLUGIN}] could not resume the work session, creating a new one: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
  const path = markerPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ sessionId: WORK_SESSION_ID, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  return { agent: handle.agent, resumed: false }
}

const KIND_BRIEFS = {
  'topic-brief': (job) =>
    [
      `Write a short brief on "${job.subject}", a tool that keeps showing up in the owner's work.`,
      'First, what the record shows: gnomon_entity_history on it, and gnomon_semantic_search for where it appears. Then web_search once or twice and web_fetch at most three pages.',
      'Shelve 120–200 words: what it is in one line, what tends to bite people, and two or three links worth opening. Skip anything the owner obviously already knows from how they use it.',
    ].join(' '),
  'handoff-note': (job) =>
    [
      `Write a handoff note for the thread "${job.subject}"${job.detail?.project ? ` in ${job.detail.project}` : ''}${job.detail?.branch ? ` (branch ${job.detail.branch})` : ''}, which went quiet on ${String(job.detail?.lastTouchedAt ?? '').slice(0, 10)}.`,
      'Use gnomon_open_commitments, gnomon_recent_activity and gnomon_code_activity for the days it was active, gnomon_moment_detail for the last sessions, and gnomon_entity_history on the task. Read, never write.',
      'Shelve 120–200 words the owner can pick the work back up from: what was being done, the last concrete steps, what looked unfinished, and the one likely next step. Name files and symbols where the record has them.',
    ].join(' '),
  // The owner's own words are the brief; the procedure lives in a skill so it
  // can be edited without a restart.
  'owner-request': (job) =>
    [
      `The owner asked for this: "${job.detail?.brief ?? job.subject}".`,
      'Load the `research-brief` skill first (call the skill tool with name "research-brief") and follow it. Keep the result to 120–250 words with sources; they asked for it, so a thin answer is worse than an honest "nothing found".',
      'Use todo_write to lay out your steps before you start — the owner can see them.',
    ].join(' '),
  // Gnomon writing one of its own rules (kernel/watch.ts), tested on the real
  // record before the owner ever sees it. The owner's Keep adopts it.
  'rule-idea': () =>
    [
      'Find ONE thing the owner would want you to notice on your own from now on, and write it as a watch rule.',
      'Start with gnomon_mine_rules: candidates enumerated from their record, each already replayed on both halves of 30 days and cleared of what Gnomon already says. Pick the one the owner would most want, and write its title and its sentence in their words (the tool\'s are placeholders); keep its conditions and trigger unless the examples show a reason. If it returns nothing, you may look yourself (gnomon_routines, gnomon_open_commitments, gnomon_tickets and the corrections below) for a rule specific to them, never one that restates what Gnomon already says (agents waiting, failing streaks, shared checkouts).',
      'Test the worded rule with gnomon_test_rule over 30 days and read the examples: each must be worth an interruption, and `holdout` must show fires in both halves. A rule that fires zero times or more than three times a day is not ready; if nothing is ready, shelve nothing.',
      'Shelve it with the tested spec as `rule`: a title "Rule idea: <its title>", and a body of at most 120 words — what it watches and why in one line, how often it would have spoken (fired N times in 30 days, and in each half) with two or three of its example sentences and their dates, and the line "Keep turns it on; Wrong throws it away."',
    ].join(' '),
  // The first touch of a workday asked for it (workbench `requestPacket`): the owner's morning sweep, gathered once.
  // The calendar, tickets and standup lines are already in the job; only the pull requests are read here.
  'day-packet': (job) =>
    [
      `Put the owner's morning packet for ${job.detail?.day ?? 'today'} on the shelf: what they would otherwise gather by opening the code host, the ticket tracker and the calendar one by one.`,
      'Call gnomon_pull_requests once: their open PRs, and which wait on a review or have failing checks. Call gnomon_tickets once (days 14) only to add a stage the job does not give. Read nothing else: no mail, no messages, no chat, no screen, no web.',
      'Shelve at most 150 words under four short headings in this order: **Pull requests**, **Tickets**, **Today**, **Standup**. Under Today and Standup use the job\'s calendar and standup lines as they are; leave a heading out when it has nothing. End with the job\'s leftOut line as written. Title: "Morning packet".',
    ].join(' '),
  // Round 5: Gnomon's own steps kept failing in one app (`selfReview`, on idle or a chat's end). One proposal, applied only on the owner's Keep.
  'self-review': (job) =>
    job.detail?.cluster === 'unbacked-claim' ? [
      `Your own replies said an act was done ${job.detail?.failures ?? 'several'} times with no act in the turn. The replies are in the job's details.`,
      'Read gnomon_signals for the chat:said rows of those turns if you need the words around them. Read nothing else.',
      'Then propose exactly ONE fix, as `review`: {"kind":"app-note","line":"<one line your brief should carry so a reply never claims an act it did not run>"}. If the rows show no fix you would bet on, shelve nothing.',
      `Shelve it with a title "${job.subject}: <the fix in a few words>" and a body of at most 80 words: what was claimed (with the count), the fix, and why it should help. Nothing changes until the owner keeps it.`,
    ].join(' ') : [
      `Your own steps in ${job.subject} kept failing: ${job.detail?.failures ?? 'several'} times "${job.detail?.cluster ?? 'refused'}". The failed steps are in the job's details.`,
      `Read what you learned there: gnomon_look with id "routes" (each route of ${job.subject} with its key, how often it worked, and the dead ends), and gnomon_signals for its screen:step rows of the last 7 days if you need the failed steps around them. Read nothing else.`,
      'Then propose exactly ONE fix, as `review`: {"kind":"drop-route","routeKey":"<the route\'s key exactly as the routes card gives it>"} for a route that keeps leading here, {"kind":"app-note","line":"<one line the brief should say about this app>"} for what a look cannot tell, or {"kind":"fact","predicate":"<camelCase>","object":"<short>"} for a fact about the app. If the rows show no fix you would bet on, shelve nothing.',
      `Shelve it with a title "${job.subject}: <the fix in a few words>" and a body of at most 80 words: what failed (with the count), the fix, and why it should help. Nothing changes until the owner keeps it.`,
    ].join(' '),
  'meeting-brief': (job) =>
    [
      `Prepare the owner for "${job.subject}" starting ${job.detail?.start ?? 'soon'}, with ${Array.isArray(job.detail?.attendees) ? job.detail.attendees.join(', ') : 'others'}.`,
      'For each person: gnomon_entity_history and gnomon_semantic_search for what the record holds on them and on the meeting title. If Obsidian or another connected service exposes READ tools, search them for the title too.',
      'Shelve at most 150 words: who is in the room and how the owner knows them, the last time this topic came up, and open threads that touch it. When the job lists promises, lead with them as they are written there — what the owner owes these people and what they owe the owner. If the record holds nothing on anyone and there are no promises, say that in one line and shelve nothing.',
    ].join(' '),
}

/** The job, as injected context: what is being asked, in the rule's words. */
export function jobContext(job) {
  const detail = Object.entries(job.detail ?? {})
    .filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: [`Gnomon opened a job for itself (${job.kind}): ${job.subject}.`, `Why now: ${job.reason}.`, detail.length > 0 ? `Details: ${detail.join('; ')}.` : null, `Job id: ${job.id}`].filter(Boolean).join('\n'),
      },
    ],
    source: { kind: PLUGIN, form: 'notice', summary: boundContextSummary(`Working on: ${job.subject}`) },
  })
}

/**
 * What the owner said when they called shelved work wrong — their own words,
 * most recent last. A verdict alone says "no"; the note says why, and without
 * it the next job makes the same mistake with the same confidence.
 *
 * Only `wrong` notes, and only on things the worker itself produced. `not-now`
 * is about timing, which the gate already handles, and `useful` needs no fix.
 */
export function correctionNotes(state, limit = 5) {
  return (state?.feedback?.recent ?? [])
    .filter((e) => e.verdict === 'wrong' && typeof e.note === 'string' && e.note.trim() !== '' && (e.artifactKind === 'knowledge_entry' || e.artifactKind === 'ask_thread'))
    .slice(-limit)
    .map((e) => e.note.trim())
}

/** The instruction that runs the worker turn. `hand`: the job runs on Claude, which answers in a schema instead of calling a tool. */
export function jobPrompt(job, corrections = [], { hand = false } = {}) {
  const brief = (KIND_BRIEFS[job.kind] ?? KIND_BRIEFS['topic-brief'])(job)
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: [
          'You are working on your own while the owner is away. Nobody is watching this session, so:',
          '• READ ONLY. Use gnomon_* read tools, web_search, web_fetch, and mcp__*__ tools that read. Never call gnomon_run_shell, gnomon_calendar_create, gnomon_assert, gnomon_propose, or any tool that writes or asks for approval — an approval prompt here would hang with nobody to answer it.',
          '• Cite what you used. Every claim that came from a page or a record names it in `sources`.',
          '• Say less. The owner reads this on a shelf between other things; a paragraph beats a report.',
          '',
          brief,
          '',
          corrections.length > 0 ? ['The owner marked earlier work of yours wrong and said why. Take it as standing instruction:', ...corrections.map((n) => `• ${n}`), ''].join('\n') : null,
          hand
            ? 'Finish with the JSON answer only: outcome "shelved" with a title of a few words, the body and the sources when there is something worth keeping, or outcome "nothing" when there is not.'
            : `Finish the turn with exactly one of: gnomon_shelve (jobId "${job.id}", a title of a few words, the body, and the sources) when there is something worth keeping, or gnomon_work_done (jobId "${job.id}", outcome "nothing") when there is not. Do not write the result as chat text — only the tool call reaches the owner.`,
        ].join('\n'),
      },
    ],
    source: { kind: PLUGIN },
  })
}

/** The `work:shelved` payload, capped the same way whoever reports it. Null when title or body is empty. */
export function shelvePayload(args = {}) {
  const title = String(args.title ?? '').trim()
  const body = String(args.body ?? '').trim()
  if (title === '' || body === '') return null
  let sources = args.sources
  if (typeof sources === 'string') {
    try {
      sources = JSON.parse(sources)
    } catch {
      sources = [sources]
    }
  }
  sources = Array.isArray(sources) ? sources.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, 300)) : []
  const jobId = typeof args.jobId === 'string' && args.jobId.trim() !== '' ? args.jobId.trim() : undefined
  // A proposed watch rule rides along untouched; `watchRules` validates it in the fold.
  const rule = typeof args.rule === 'string' ? safeJson(args.rule) : args.rule
  // So does a self-review's one proposal; `selfReview` validates it in the fold.
  const review = typeof args.review === 'string' ? safeJson(args.review) : args.review
  return { title: title.slice(0, 140), body: body.slice(0, 6000), sources, ...(jobId ? { jobId } : {}), ...(rule && typeof rule === 'object' ? { rule } : {}), ...(review && typeof review === 'object' ? { review } : {}) }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The `work:closed` payload. */
export function workDonePayload(args = {}) {
  const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim().slice(0, 300) : undefined
  return { jobId: String(args.jobId ?? '').trim(), outcome: args.outcome === 'failed' ? 'failed' : 'nothing', ...(note ? { note } : {}) }
}

/**
 * Register the two return-path tools and the executor's `subagent` actor (W3):
 * `StartSubagent` runs a job, `StopSubagent` aborts it. The executor awaits the
 * start, folds `work:started` (or `work:closed failed` on a throw), and closes a
 * job whose `done` settles without a report.
 *
 * @returns dispose function for the agent reference and the actor (the tools are ctx-scoped).
 */
export function installWorkLoop(ctx, { home, cwd, isDisposed = () => false, onShelved = () => {}, log = console.log, warn = console.warn, llm = {}, jobs = {}, resolveClaudeFn = resolveClaude, spawnFn, runtimes = {} } = {}) {
  /** Live jobs, so shutdown can end them rather than leaving children running. */
  const inFlight = new Map()
  /**
   * S4: the sandbox a report on a job belongs to, as the mark its row carries: the job's own (in flight, or one a rig chat's
   * sandbox holds). A sandbox job's result is a line in that rig thread, never the owner's shelf, phone or strip. A sandbox
   * job has no dsh child (`run` refuses one), so no child of it can call these tools with no jobId or another's.
   */
  const markOf = (jobId) => {
    const sandbox = inFlight.get(jobId)?.sandbox ?? (jobId ? sandboxOf(ctx.gnomonKernel?.getState?.(), { type: 'work:shelved', payload: { jobId } }) : null)
    return sandbox ? { sandbox } : {}
  }
  ctx.tools.register(
    defineTool({
      name: 'gnomon_shelve',
      description: [
        'Put something you made on the owner\'s shelf — the place in the tab where your own work waits for them with Keep / Not now.',
        'Use it to finish a job Gnomon opened for itself (pass its jobId), or when a conversation produced a brief, a note or a summary the owner asked to keep.',
        'Title: a few words. Body: short prose, Markdown allowed. Sources: the pages, records or tools each claim rests on.',
      ].join(' '),
      parameters: {
        title: { type: 'string', required: true, description: 'A few words the owner can recognise it by.' },
        body: { type: 'string', required: true, description: 'The thing itself. Short; Markdown allowed.' },
        sources: { type: 'json', description: 'Array of strings: URLs, record ids, tool names — what the body rests on.' },
        jobId: { type: 'string', description: 'The job id when finishing a job Gnomon opened; omit for something the owner asked to keep.' },
        rule: { type: 'json', description: 'Only for a rule-idea job: the watch rule you tested with gnomon_test_rule. The owner\'s Keep adopts it.' },
        review: { type: 'json', description: 'Only for a self-review job: the one proposal (drop-route, app-note or fact). The owner\'s Keep applies it.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { shelved: { type: 'boolean' }, title: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.shelved ? `Shelved "${value.title}".` : 'Not shelved.' }],
      },
      async execute(args) {
        const payload = shelvePayload(args)
        if (payload === null) throw new Error('title and body are required')
        const mark = markOf(payload.jobId)
        await ctx.gnomonKernel.appendSignal('work:shelved', { ...payload, ...mark })
        if (!mark.sandbox) onShelved(payload.title)
        return { shelved: true, title: payload.title }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'gnomon_work_done',
      description: 'Close a job Gnomon opened for itself WITHOUT shelving anything — the record held too little, or the search turned up nothing worth the owner\'s time. Pass the jobId. Honest emptiness beats a padded note.',
      parameters: {
        jobId: { type: 'string', required: true, description: 'The job id from the job context.' },
        outcome: { type: 'string', description: '"nothing" (default) or "failed" when a tool broke.' },
        note: { type: 'string', description: 'One line on why, for the ledger.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean' }, jobId: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.closed ? `Closed job ${value.jobId}.` : 'Not closed.' }],
      },
      async execute(args) {
        const payload = workDonePayload(args)
        if (payload.jobId === '') throw new Error('jobId is required')
        await ctx.gnomonKernel.appendSignal('work:closed', { ...payload, ...markOf(payload.jobId) })
        return { closed: true, jobId: payload.jobId }
      },
    }),
  )

  let worker = null

  // Said at boot rather than left to be discovered from the first job's log
  // line. The fallback below is deliberate but it degrades SILENTLY — a wrong
  // service name would look exactly like a profile without the plugin — and a
  // silent degradation is the failure class this whole pass exists to remove.
  const provider = ctx.get?.('subagents')
  // `llm.roles.jobs`: the runtime sources a job runs on, in order (claude-hand.js); a limit on the
  // first moves the job to the next. Resolved once; without any, jobs stay on dsh and the log says why.
  const listed = (llm.roles?.jobs ?? []).map((e) => { const i = e.indexOf(':'); return { source: i < 0 ? e : e.slice(0, i), model: i < 0 ? undefined : e.slice(i + 1) || undefined } }).filter((c) => isRuntimeSource(c.source))
  const claudePath = listed.some((c) => c.source === 'claude') ? resolveClaudeFn(llm.sources?.claude?.path ?? null) : null
  if (claudePath) setRuntime('claude', claudeRuntime({ binary: claudePath, ...(spawnFn ? { spawn: spawnFn } : {}) }))
  for (const [source, runtime] of Object.entries(runtimes)) setRuntime(source, runtime)
  const candidates = listed.filter((c) => c.source !== 'claude' || claudePath)
  const maxUsdPerJob = jobs.maxUsdPerJob ?? 2
  if (listed.length > 0) log(candidates.length > 0 ? `[${PLUGIN}] work jobs run on ${candidates.map((c) => c.source + (c.model ? `:${c.model}` : '')).join(', then ')}, at most $${maxUsdPerJob} each` : `[${PLUGIN}] llm.roles.jobs names claude but no claude binary was found — jobs stay on dsh`)
  else log(
    typeof provider?.start === 'function'
      ? `[${PLUGIN}] work jobs run as '${SUBAGENT_PROVIDER}' subagents, one fresh context each, abandoned after ${JOB_TIMEOUT_MS / 60000}m`
      : `[${PLUGIN}] no subagent provider — work jobs run on the shared work session (context accumulates, and a job cannot be stopped)`,
  )

  /** One job; resolves once it is under way (`{childId, done}`), throws when it cannot start. The executor calls it off its lane and folds the answer. */
  async function run(job, reserve) {
    if (isDisposed()) throw new Error('the work loop is shutting down')
    if (!job || typeof job !== 'object' || typeof job.id !== 'string' || typeof job.kind !== 'string') throw new Error('a work job with no id or kind')
    // A brief for a meeting that has already started is not worth a model call: the fold asked for it
    // in event time (a replay, a back-fill), and the worker runs on the wall clock.
    const meetingStart = Date.parse(job.detail?.start ?? '')
    if (job.kind === 'meeting-brief' && Number.isFinite(meetingStart) && Date.now() > meetingStart) throw new Error('not run: the meeting had already started')
    // S4: a rig chat's sandbox job runs on a runtime with no tools at all, or not at all: a dsh child would inherit every
    // tool and the owner's brief, in a session the gate does not know as the rig's.
    if (job.sandbox) {
      if (candidates.length === 0) throw new Error('a sandbox job needs a runtime')
      return runOnRuntime(job, null)
    }
    // The morning packet is a cheap gather, not research: it stays on the work agent's own (flash) route, never a Claude hand.
    // So is a self-review: a cheap read of Gnomon's own steps.
    if (candidates.length > 0 && job.kind !== 'day-packet' && job.kind !== 'self-review') return runOnRuntime(job, reserve)
    if (worker === null || worker.status === 'disposed') {
      const { agent, resumed } = await ensureWorkAgent(ctx, { home, cwd })
      worker = agent
      log(`[${PLUGIN}] work session ${agent.id} (${resumed ? 'resumed' : 'created'})`)
    }

    // Resolved at call time, not injected: cordis treats an injected name as a
    // service to WAIT for, so declaring it would stop this plugin loading on a
    // profile without `@deepseek-ai/dsh-subagent`. Absent, the job runs on the
    // parent exactly as it did before — a background job getting done matters
    // more than which agent does it.
    const corrections = correctionNotes(ctx.gnomonKernel?.getState?.())
    // W1: a job is briefed like a turn (the clock and the owner's memory), without the reply rules.
    const told = await Promise.resolve(ctx.gnomonKernel?.brief?.({ sessionId: WORK_SESSION_ID, cause: { kind: 'work' } })).catch(() => null)
    const subagents = ctx.get?.('subagents')
    if (subagents === undefined || typeof subagents.start !== 'function') {
      if (told) worker.inject(createUserMessage({ content: [{ type: 'text', text: told.text }], source: { kind: PLUGIN, form: 'notice', summary: boundContextSummary(told.present) } }))
      worker.inject(jobContext(job))
      worker.followup(jobPrompt(job, corrections))
      log(`[${PLUGIN}] working on ${job.kind}: ${job.subject} (on the work session — no subagent provider)`)
      return { childId: null }
    }

    // One child per job. The persistent `gnomon-work` agent stays and becomes
    // the PARENT, which dsh requires: a child composes from its parent's ctx
    // (`applyChildComposition`), so it inherits the same tools — including
    // `gnomon_shelve` and `gnomon_work_done`, which are how a job reports.
    //
    // Two things this buys, and only these two:
    //
    //   - A fresh context per job. Every job used to be a `followup` on the one
    //     work session, so job N carried jobs 1..N-1 with it; that transcript
    //     had grown to 656 KB, the second-largest session on the machine.
    //   - A way to STOP. Nothing could abort a running job — `JOB_TIMEOUT_MS`
    //     only closed the rule-side record while the turn kept going. The
    //     controller below is the first thing that can actually end one, and it
    //     is armed with the same constant the rule gives up at, so the two
    //     halves agree about when a job is over.
    //
    // dsh pins a delegated child's approval policy to 'never'
    // (`captureDelegatedPolicyOverrides`), so a job cannot raise a permission
    // prompt while the owner is away. That is a behaviour change and the right
    // one: these jobs run unattended by definition.
    const controller = new AbortController()
    const expiry = setTimeout(() => controller.abort(`job ${job.id} passed ${JOB_TIMEOUT_MS}ms`), JOB_TIMEOUT_MS)
    // Unref so a pending job cannot hold the process open at shutdown.
    expiry.unref?.()
    inFlight.set(job.id, { controller, childId: null })

    const route = workRoute(ctx)
    let started
    try {
      started = await subagents.start(SUBAGENT_PROVIDER, {
        label: `${job.kind}: ${job.subject}`.slice(0, 120),
        // The same two strings the parent used to receive as an injected
        // context block and a followup — unchanged, so the briefs in
        // KIND_BRIEFS keep working exactly as written.
        prompt: [{ type: 'text', text: `${told ? `${told.text}\n\n` : ''}${promptText(jobContext(job))}\n\n${promptText(jobPrompt(job, corrections))}` }],
        parent: worker,
        signal: controller.signal,
        // Named per job. A child inherits the parent's LAST request header, and the work agent never asks the model
        // itself: on the record every child ran on the route of 2026-09-09 and died on its 401 in 3 to 5 s.
        agentOptions: { provider: route.provider, model: route.model },
      })
    } catch (error) {
      clearTimeout(expiry)
      inFlight.delete(job.id)
      warn(`[${PLUGIN}] could not start a child for ${job.kind}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    inFlight.set(job.id, { controller, childId: started.id })
    log(`[${PLUGIN}] working on ${job.kind}: ${job.subject} (child ${started.id})`)

    // Not awaited: the lane must not wait out a twenty-minute job. The job
    // reports through its own tools, so there is nothing here to collect but
    // why it ended when it did not finish: the executor closes a job that ended
    // without a report, and puts this reason in the close.
    const done = started.result
      .then((result) => {
        const why = result.stopReason === 'completed' ? null : [result.stopReason, inFlight.get(job.id)?.error ?? result.diagnostic].filter(Boolean).join(': ')
        log(`[${PLUGIN}] child ${started.id} finished (${why ?? result.stopReason})`)
        return why
      })
      .catch((error) => {
        const why = error instanceof Error ? error.message : String(error)
        warn(`[${PLUGIN}] child ${started.id} failed: ${why}`)
        return why
      })
      .finally(() => {
        clearTimeout(expiry)
        inFlight.delete(job.id)
        started.dispose?.()
      })
    return { childId: started.id, done }
  }

  /** One job on the runtime candidates: one `hand` call reserved, one audit row per attempt, closed exactly once, stoppable like a dsh child. */
  async function runOnRuntime(job, reserve) {
    // W3: a budgeted purpose like any model call; the reservation's id is the first audit row's.
    // S4: a sandbox job never draws on the owner's hand budget (one job per rig chat at a time, SANDBOX_USD_PER_JOB).
    const callId = reserve && !job.sandbox ? await reserve('hand') : undefined
    if (callId === null) throw new Error("today's hand budget is spent")
    const corrections = correctionNotes(ctx.gnomonKernel?.getState?.())
    const prompt = [job.sandbox ? SANDBOX_PREAMBLE : handPreamble(job), promptText(jobContext(job)), promptText(jobPrompt(job, corrections, { hand: true }))].join('\n\n')
    const controller = new AbortController()
    const expiry = setTimeout(() => controller.abort(`job ${job.id} passed ${JOB_TIMEOUT_MS}ms`), JOB_TIMEOUT_MS)
    expiry.unref?.()
    inFlight.set(job.id, { controller, childId: null, ...(job.sandbox ? { sandbox: job.sandbox } : {}) })
    log(`[${PLUGIN}] working on ${job.kind}: ${job.subject} (${candidates.map((c) => c.source).join(', then ')})`)
    // The one audit point: every attempt is a row in llm_audit, chained by parentCallId (the router's rule).
    let audit = null
    let requestedAt = Date.now()
    let previousRowId = null
    const onAttempt = async ({ index, source, model }) => {
      requestedAt = Date.now()
      audit = await Promise.resolve(ctx.gnomonKernel.openLlmAudit?.({ ...(index === 0 && callId ? { id: callId } : {}), momentId: null, purpose: 'hand', model: `${source}/${model ?? 'default'}`, route: source, access: 'runtime', prompt, attempt: index + 1, parentCallId: previousRowId, requestedAt: new Date(requestedAt).toISOString() })).catch((error) => (warn(`[${PLUGIN}] hand audit: ${error.message}`), null))
      previousRowId = audit?.id ?? previousRowId
    }
    const onSettled = async (_attempt, run) => {
      const valid = !run.error && run.structured && (run.structured.outcome === 'shelved' || run.structured.outcome === 'nothing')
      await audit
        ?.settle({
          respondedAt: new Date().toISOString(),
          latencyMs: Date.now() - requestedAt,
          success: Boolean(valid),
          responseContent: valid ? JSON.stringify(run.structured).slice(0, 20000) : null,
          promptTokens: run.promptTokens ?? undefined,
          completionTokens: run.completionTokens ?? undefined,
          totalTokens: run.promptTokens !== null || run.completionTokens !== null ? (run.promptTokens ?? 0) + (run.completionTokens ?? 0) : undefined,
          cacheReadTokens: run.cacheReadTokens ?? undefined,
          error: run.error ? run.error.message : valid ? undefined : 'no structured result',
          ...(run.error?.status ? { statusCode: run.error.status } : {}),
        })
        .catch((e) => warn(`[${PLUGIN}] hand audit: ${e.message}`))
    }

    const box = job.sandbox ? { tools: 'none', maxBudgetUsd: SANDBOX_USD_PER_JOB } : { maxBudgetUsd: maxUsdPerJob }
    const mark = job.sandbox ? { sandbox: job.sandbox } : {}
    // The runtime's own timer ends a minute before the job's, so a job that runs long says so instead of being cut.
    const done = runHand({ candidates, prompt, home, ...box, signal: controller.signal, timeoutMs: JOB_TIMEOUT_MS - 60_000, onAttempt, onSettled }).then(async ({ ok, result, error, run, source }) => {
      clearTimeout(expiry)
      inFlight.delete(job.id)
      const payload = ok && result.outcome === 'shelved' ? shelvePayload({ ...result, jobId: job.id }) : null
      try {
        if (payload) {
          await ctx.gnomonKernel.appendSignal('work:shelved', { ...payload, ...mark })
          if (!job.sandbox) onShelved(payload.title)
        } else {
          await ctx.gnomonKernel.appendSignal('work:closed', { ...workDonePayload({ jobId: job.id, outcome: ok ? 'nothing' : 'failed', note: ok ? `${source} found nothing worth keeping` : redactSecrets(String(error)) }), ...mark })
        }
      } catch (e) {
        warn(`[${PLUGIN}] could not report a ${source} job: ${e instanceof Error ? e.message : String(e)}`)
      }
      log(`[${PLUGIN}] ${source} job ${job.id} ${payload ? 'shelved' : ok ? 'found nothing' : `failed: ${error}`}${run?.costUsd != null ? ` ($${run.costUsd.toFixed(3)})` : ''}`)
    })
    return { childId: null, done }
  }

  const unregister = ctx.gnomonKernel.registerActor?.('subagent', {
    start: ({ job }, lane = {}) => run(job, lane.reserve),
    // The owner's Stop: abort the child; the executor folds the close, so the slot is free.
    stop: async ({ jobId }) => {
      inFlight.get(jobId)?.controller.abort(`job ${jobId} stopped by the owner`)
    },
  })

  // A child's plan (`todo_write`) is the owner's window on a running job. Its
  // session log is the source; this only relays the latest list under the job
  // id, and the web shell draws it on the strip.
  ctx.on('session/event', (session, event) => {
    // Why a child's turn failed (the model call's own error), kept for the close: the result only says "error".
    if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      const e = event.data.reason.error ?? {}
      for (const entry of inFlight.values()) if (entry.childId === session?.id) entry.error = [e.code, e.status].filter(Boolean).join(' ') + (e.message ? `${e.code || e.status ? ': ' : ''}${String(e.message).slice(0, 160)}` : '')
      return
    }
    if (event?.type !== 'todo/write') return
    for (const [jobId, entry] of inFlight) {
      if (entry.childId === session?.id && !entry.sandbox) ctx.emit('gnomon/working', { jobId, todos: Array.isArray(event.data?.todos) ? event.data.todos : [] })
    }
  })

  return () => {
    // Abort every child before dropping the parent reference. Without this a
    // reload left orphaned children spending budget against a plugin that no
    // longer exists to receive their results.
    for (const [jobId, { controller }] of inFlight) controller.abort(`sundial-proactive disposed while job ${jobId} was running`)
    inFlight.clear()
    worker = null
    unregister?.()
  }
}
