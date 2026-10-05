// sundial-kernel: the event-sourced kernel, folding inside the dsh process.
//
// Thin adapter over @sundial/harness-runtime's KernelRuntime (itself ported
// from apps/daemon/src/daemon/index.ts — boot replay, serialized fold lane,
// the full effect executor, budget-checked LLM dispatchers). This file only
// wires lifecycle: env loading, boot, the clock:tick timer, the service, and
// graceful shutdown.
//
// Notice delivery contract (Phase 5 handshake): the kernel's `Notify` effect
// is emitted here as the Cordis event `gnomon/notice` with payload
// { channel, payload } — the sundial-proactive plugin subscribes with
// ctx.on('gnomon/notice', …) to inject/wake the companion agent. Until that
// plugin exists, the console.log inside KernelRuntime is the only sink.
//
// Signals vs session logs: `signals` is the record, the chat included (W1:
// `chat:shown` from `brief()` here, `chat:owner` / `chat:said` from the chat
// recorder, sanitized at ingest, 30 days); dsh session logs stay the
// transcript the owner reads. This plugin never writes a session log and dsh
// never writes signals.
//
// Named exports only — a default export drops `inject`.
import { randomUUID } from 'node:crypto'
import { KernelRuntime, briefParts, openLlmAudit, gatherAmbientInput, loadOrGenerateDeviceId, presentLine, renderBrief, shownPayload, turnBrief } from '@sundial/harness-runtime/index.js'
import { existingDefaultRoots, lastBackfill, planBackfill, runBackfill } from '@sundial/harness-runtime/backfill.js'
import { installLastGoodLookup } from '@sundial/helpers/dns-last-good.js'
import { loadSundialEnv } from '@sundial/helpers/sundial-env.js'

export const name = 'sundial-kernel'
// W1 step 7: the nightly conversation pass reads the log's `chat:owner` rows, not dsh's session store.
export const inject = ['gnomonDb', 'gnomonMemory']


const CLOCK_TICK_INTERVAL_MS = 60_000

/**
 * `gnomonKernel.brief`, over anything with `getState` and `appendSignal` (exported for its test).
 * The ambient memory is read here, once per turn (W1 step 5: no timer, no cache);
 * `sections` are the other plugins' blocks (the board), read from the same state.
 * `recorded` settles once `chat:shown` has folded, for a caller that reads the cause back.
 *
 * A chat is told each unchanged part of its brief once: `given` remembers, per
 * session, the parts already in that session's history. Compaction rewrites the
 * history, so `forget()` (on `compaction/end`) makes the next brief whole again;
 * so does a restart. A work brief is not remembered: a job can hand its brief
 * to a helper in another session, and the work session never sees it.
 */
export function briefFor(runtime, { now = Date.now, gather = (state) => gatherAmbientInput({ state }), sections = () => [] } = {}) {
  const warn = (what) => (error) => console.warn(`[sundial-kernel] ${what}: ${error instanceof Error ? error.message : String(error)}`)
  const given = new Map()
  const brief = async (input) => {
    const state = runtime.getState()
    const memory = await Promise.resolve().then(() => gather(state)).catch((error) => (warn('ambient memory not read')(error), null))
    const shown = turnBrief(state, memory, input, now())
    const briefId = `brief-${randomUUID()}`
    const recorded = Promise.resolve(runtime.appendSignal('chat:shown', shownPayload(shown, briefId))).catch(warn('chat:shown not recorded'))
    const parts = sections(state)
    const remembered = shown.cause.kind === 'work' ? null : (given.get(input.sessionId) ?? given.set(input.sessionId, new Set()).get(input.sessionId))
    const text = renderBrief(shown, parts, remembered ?? undefined)
    for (const part of remembered ? briefParts(shown, parts) : []) remembered.add(part)
    return { briefId, text, present: presentLine(shown), recorded }
  }
  brief.forget = () => given.clear()
  return brief
}

export async function apply(ctx, config = {}) {
  // ~/.sundial/.env → process.env (SUNDIAL_LLM_BASE_URL/MODEL/API_KEY for the
  // effect executor's purpose calls via @sundial/llm). Existing process.env
  // values win; values are never logged.
  loadSundialEnv()
  // Process-wide: every plugin's model call, the chat's included, rides out a DNS failure on the last good address.
  installLastGoodLookup()

  const deviceId = loadOrGenerateDeviceId()
  const runtime = new KernelRuntime({
    deviceId,
    onNotify: (notice) => {
      // Cordis event for the Phase 5 proactive plugin; payload is
      // { channel: 'phasic'|'tonic'|…, payload: <the rule's notice payload> }.
      ctx.emit('gnomon/notice', notice)
    },
    // Live invalidation. The fold names the tables it wrote and this relays
    // them verbatim; sundial-theme's `/gnomon/api/live` turns them into a
    // `stale` frame and each open card re-reads only if its own reading is in
    // the list. The table name is the whole vocabulary — see `tablesTouched`.
    onChange: (tables) => ctx.emit('gnomon/changed', tables),
  })

  // Register shutdown BEFORE the timer: disposers run in reverse order, so on
  // unload the tick timer is cleared first, then the runtime drains its
  // serialized lane and flushes a final snapshot (the daemon's stopDaemon()).
  ctx.effect(() => () => runtime.shutdown(), 'sundial-kernel shutdown')

  // Boot: latest kernel_state_snapshot + signal-tail replay (exactly the
  // daemon's startDaemon sequence; migrations already ran in sundial-db).
  const boot = await runtime.boot()
  console.log(
    `[sundial-kernel] boot replay: snapshot offset ${boot.snapshotOffset ?? '<none>'}, tail ${boot.tailLength} signal(s)`,
  )

  // clock:tick — the ONE scheduler (never dsh's session-local schedule
  // package). Logs the tick signal and writes the snapshot each minute,
  // exactly the daemon's cadence.
  ctx.effect(() => {
    const timer = setInterval(() => {
      runtime.tickClock().catch((error) => console.error('[sundial-kernel] clock tick failed:', error))
    }, config.clockTickIntervalMs ?? CLOCK_TICK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'sundial-kernel clock:tick')

  // W1: blocks other plugins add to every brief (the board, from sundial-tools). Service wiring, not fold state.
  const sections = new Set()
  const briefSections = (state) => [...sections].map((fn) => { try { return fn(state) } catch { return '' } }).filter((text) => typeof text === 'string' && text !== '')

  const brief = briefFor(runtime, { sections: briefSections })
  // Compaction rewrote some session's history: every chat is briefed whole on its next turn.
  ctx.on('compaction/end', () => brief.forget())

  ctx.provide('gnomonKernel', {
    /** Append one signal: sanitize → signals log → reduce(RULE_MANIFEST) → effects. Serialized. */
    appendSignal: (type, payload, ts) => runtime.appendSignal(type, payload, ts),
    // A judgement a tool needs inside a turn (J1.3's rerank). Budgeted and
    // audited; null when judging is off, exhausted or failing.
    judgeNow: (options) => runtime.judgeNow(options),
    // W3: the one budget gate — (purpose, { caller }) → a call id, or null when the cap is spent.
    reserveLlmCall: (purpose, options) => runtime.reserveLlmCall(purpose, options),
    // W3: the one writer of llm_audit, for model callers outside the kernel (the chat ledger, the Claude hand).
    openLlmAudit,
    // W3: a plugin's doer for the action effects ('job': StartJob/StopJob, 'subagent': StartSubagent/StopSubagent). Returns its unregister.
    registerActor: (kind, actor) => runtime.registerActor(kind, actor),
    // J2.6: the rejudge job's state (W3: started by appending `rejudge:requested`).
    rejudgeStatus: () => runtime.rejudgeStatus(),
    // J5.4: question id → set · key, for the Trust page's self-evaluation.
    questionCatalog: () => runtime.questionCatalog(),
    // J4.1 / J4.2: the judge's reading of an action before and after (null when judging is unavailable).
    classifyAction: (tool, args) => runtime.classifyAction(tool, args),
    verifyAction: (tool, args, result) => runtime.verifyAction(tool, args, result),
    /** The live KernelState (null only before boot completes). */
    getState: () => runtime.getState(),
    /**
     * W1: what a turn is shown. Builds the brief from the live state, queues its
     * `chat:shown` on the lane (FIFO, so it lands before the turn's `chat:owner`)
     * and returns the text to inject and a one-line summary of the present.
     * `input`: { sessionId, cause?, place?, answering?, text? }. Async: it reads
     * the ambient memory. `recorded` settles when `chat:shown` has folded.
     */
    brief,
    /** W1: add a block to every brief, `(state) => text`; returns its removal. */
    briefSection: (fn) => (sections.add(fn), () => sections.delete(fn)),
    /** The first-run back-fill on /setup: defaults, a dry count, the run, and the last run. */
    backfill: {
      defaults: () => existingDefaultRoots(),
      plan: (opts) => planBackfill(opts),
      run: (opts) => runBackfill(opts, (type, payload, ts) => runtime.appendSignal(type, payload, ts)),
      last: () => lastBackfill(),
    },
    /** On-demand project-status generation (Phase 4 tool hook). */
    dispatchRunProjectStatus: (projectId) => runtime.dispatchRunProjectStatus(projectId),
  })
  console.log('[sundial-kernel] ready')
}
