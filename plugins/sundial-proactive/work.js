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
import { handPreamble, resolveClaude, runClaudeHand } from './claude-hand.js'

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
  child.inject(createUserMessage({ content: [{ type: 'text', text: told.text }], source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(told.present) } }))
  return true
}

function markerPath(home) {
  return `${home}/.daemon/work-session.json`
}

/** Find-or-create the one worker agent — the same three tiers the companion and the Ask agent use. */
export async function ensureWorkAgent(ctx, { home, cwd }) {
  const sessionId = SessionId(WORK_SESSION_ID)
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return { agent: live, resumed: true }

  const selection = chatDefault(ctx.agentDefaultModel.currentSelection(), ctx.gnomonKernel?.getState()?.config.llm)
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
    source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(`Working on: ${job.subject}`) },
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
    source: { kind: 'plugin', plugin: PLUGIN },
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
  return { title: title.slice(0, 140), body: body.slice(0, 6000), sources, ...(jobId ? { jobId } : {}), ...(rule && typeof rule === 'object' ? { rule } : {}) }
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
export function installWorkLoop(ctx, { home, cwd, isDisposed = () => false, onShelved = () => {}, log = console.log, warn = console.warn, hands = {}, resolveClaudeFn = resolveClaude, spawnFn } = {}) {
  /** Live jobs, so shutdown can end them rather than leaving children running. */
  const inFlight = new Map()
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
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { shelved: { type: 'boolean' }, title: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.shelved ? `Shelved "${value.title}".` : 'Not shelved.' }],
      },
      async execute(args) {
        const payload = shelvePayload(args)
        if (payload === null) throw new Error('title and body are required')
        await ctx.gnomonKernel.appendSignal('work:shelved', payload)
        onShelved(payload.title)
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
        await ctx.gnomonKernel.appendSignal('work:closed', payload)
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
  // `hands.claude`: jobs run on the owner's Claude Code instead (claude-hand.js).
  // Resolved once; absent, jobs stay on dsh and the log says why.
  const claudePath = hands.claude ? resolveClaudeFn(hands.claudePath ?? null) : null
  if (hands.claude) log(claudePath ? `[${PLUGIN}] work jobs run on Claude Code (${claudePath}), at most $${hands.maxBudgetUsd ?? 1} each` : `[${PLUGIN}] hands.claude is on but no claude binary was found — jobs stay on dsh`)
  else log(
    typeof provider?.start === 'function'
      ? `[${PLUGIN}] work jobs run as '${SUBAGENT_PROVIDER}' subagents, one fresh context each, abandoned after ${JOB_TIMEOUT_MS / 60000}m`
      : `[${PLUGIN}] no subagent provider — work jobs run on the shared work session (context accumulates, and a job cannot be stopped)`,
  )

  /** One job; resolves once it is under way (`{childId, done}`), throws when it cannot start. The executor calls it off its lane and folds the answer. */
  async function run(job, reserve) {
    if (isDisposed()) throw new Error('the work loop is shutting down')
    if (!job || typeof job !== 'object' || typeof job.id !== 'string' || typeof job.kind !== 'string') throw new Error('a work job with no id or kind')
    if (claudePath) return runOnClaude(job, reserve)
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
      if (told) worker.inject(createUserMessage({ content: [{ type: 'text', text: told.text }], source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(told.present) } }))
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
    // reports through its own tools, so there is nothing here to collect — only
    // cleanup; the executor closes it if it ends without a report.
    const done = started.result
      .then((result) => log(`[${PLUGIN}] child ${started.id} finished (${result.stopReason})`))
      .catch((error) => warn(`[${PLUGIN}] child ${started.id} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        clearTimeout(expiry)
        inFlight.delete(job.id)
        started.dispose?.()
      })
    return { childId: started.id, done }
  }

  /** One job on Claude Code: one `hand` call reserved and audited, closed exactly once, stoppable like a dsh child. */
  async function runOnClaude(job, reserve) {
    // W3: a budgeted purpose like any model call; the reservation's id is the audit row's.
    const callId = reserve ? await reserve('hand') : undefined
    if (callId === null) throw new Error("today's hand budget is spent")
    const corrections = correctionNotes(ctx.gnomonKernel?.getState?.())
    const prompt = [handPreamble(job), promptText(jobContext(job)), promptText(jobPrompt(job, corrections, { hand: true }))].join('\n\n')
    const controller = new AbortController()
    const expiry = setTimeout(() => controller.abort(`job ${job.id} passed ${JOB_TIMEOUT_MS}ms`), JOB_TIMEOUT_MS)
    expiry.unref?.()
    inFlight.set(job.id, { controller, childId: null })
    // The one audit point: every model call is a row in llm_audit, this one too.
    const requestedAt = Date.now()
    const audit = await Promise.resolve(ctx.gnomonKernel.openLlmAudit?.({ ...(callId ? { id: callId } : {}), momentId: null, purpose: 'hand', model: 'claude-code', route: 'claude-code', prompt, requestedAt: new Date(requestedAt).toISOString() })).catch((error) => warn(`[${PLUGIN}] hand audit: ${error.message}`))
    log(`[${PLUGIN}] working on ${job.kind}: ${job.subject} (Claude Code)`)

    const done = runClaudeHand({ prompt, home, claudePath, maxBudgetUsd: hands.maxBudgetUsd ?? 1, signal: controller.signal, ...(spawnFn ? { spawnFn } : {}) }).then(async ({ ok, result, error, envelope }) => {
      clearTimeout(expiry)
      inFlight.delete(job.id)
      const usage = envelope?.usage ?? {}
      const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      await audit
        ?.settle({
          respondedAt: new Date().toISOString(),
          latencyMs: Date.now() - requestedAt,
          success: ok,
          responseContent: ok ? JSON.stringify(result).slice(0, 20000) : null,
          promptTokens: envelope ? promptTokens : undefined,
          completionTokens: usage.output_tokens,
          totalTokens: envelope ? promptTokens + (usage.output_tokens ?? 0) : undefined,
          cacheReadTokens: usage.cache_read_input_tokens,
          error: ok ? undefined : error,
        })
        .catch((e) => warn(`[${PLUGIN}] hand audit: ${e.message}`))
      const payload = ok && result.outcome === 'shelved' ? shelvePayload({ ...result, jobId: job.id }) : null
      try {
        if (payload) {
          await ctx.gnomonKernel.appendSignal('work:shelved', payload)
          onShelved(payload.title)
        } else {
          await ctx.gnomonKernel.appendSignal('work:closed', workDonePayload({ jobId: job.id, outcome: ok ? 'nothing' : 'failed', note: ok ? 'Claude found nothing worth keeping' : redactSecrets(String(error)) }))
        }
      } catch (e) {
        warn(`[${PLUGIN}] could not report a Claude job: ${e instanceof Error ? e.message : String(e)}`)
      }
      log(`[${PLUGIN}] Claude job ${job.id} ${payload ? 'shelved' : ok ? 'found nothing' : `failed: ${error}`}${envelope?.total_cost_usd != null ? ` ($${envelope.total_cost_usd.toFixed(3)})` : ''}`)
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
    if (event?.type !== 'todo/write') return
    for (const [jobId, entry] of inFlight) {
      if (entry.childId === session?.id) ctx.emit('gnomon/working', { jobId, todos: Array.isArray(event.data?.todos) ? event.data.todos : [] })
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
