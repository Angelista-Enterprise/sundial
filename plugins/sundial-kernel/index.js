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
// Signals vs session logs: `signals` stays the telemetry source of truth;
// dsh session logs stay conversation truth. This plugin never writes a
// session log and dsh never writes signals.
//
// Named exports only — a default export drops `inject`.
import { KernelRuntime, createSessionConversationSource, loadOrGenerateDeviceId } from '@sundial/harness-runtime/index.js'
import { existingDefaultRoots, lastBackfill, planBackfill, runBackfill } from '@sundial/harness-runtime/backfill.js'
import { loadSundialEnv } from '@sundial/helpers/sundial-env.js'

export const name = 'sundial-kernel'
// `sessionQuery` is dsh's durable session log — the ONE place the nightly
// conversation pass reads the owner's chat turns from (see
// `@sundial/rules/conversation-extract`). Injected here because this plugin
// owns the runtime that executes the effect; the transcript never crosses
// into the signal log, only the extracted candidates do.
export const inject = ['gnomonDb', 'gnomonMemory', 'sessionQuery']


const CLOCK_TICK_INTERVAL_MS = 60_000

export async function apply(ctx, config = {}) {
  // ~/.sundial/.env → process.env (SUNDIAL_LLM_BASE_URL/MODEL/API_KEY for the
  // effect executor's purpose calls via @sundial/llm). Existing process.env
  // values win; values are never logged.
  loadSundialEnv()

  const deviceId = loadOrGenerateDeviceId()
  const runtime = new KernelRuntime({
    deviceId,
    onNotify: (notice) => {
      // Cordis event for the Phase 5 proactive plugin; payload is
      // { channel: 'phasic'|'tonic'|…, payload: <the rule's notice payload> }.
      ctx.emit('gnomon/notice', notice)
    },
    conversationSource: createSessionConversationSource(ctx.sessionQuery),
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

  ctx.provide('gnomonKernel', {
    /** Append one signal: sanitize → signals log → reduce(RULE_MANIFEST) → effects. Serialized. */
    appendSignal: (type, payload, ts) => runtime.appendSignal(type, payload, ts),
    // A judgement a tool needs inside a turn (J1.3's rerank). Budgeted and
    // audited; null when judging is off, exhausted or failing.
    judgeNow: (options) => runtime.judgeNow(options),
    // J2.6: the rejudge job (backfill every moment through `moment-fanout`) and its progress.
    rejudge: (opts) => runtime.rejudge(opts),
    rejudgeStatus: () => runtime.rejudgeStatus(),
    // J5.4: question id → set · key, for the Trust page's self-evaluation.
    questionCatalog: () => runtime.questionCatalog(),
    // J4.1 / J4.2: the judge's reading of an action before and after (null when judging is unavailable).
    classifyAction: (tool, args) => runtime.classifyAction(tool, args),
    verifyAction: (tool, args, result) => runtime.verifyAction(tool, args, result),
    /** The live KernelState (null only before boot completes). */
    getState: () => runtime.getState(),
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
