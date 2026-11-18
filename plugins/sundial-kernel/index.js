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
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js'
import { skillLabel } from '@sundial/helpers/screen-routes.js'
import { setModelPort } from '@sundial/llm/index.js'
import { dshModelPort } from './dsh-model-port.js'
import { KernelRuntime, briefParts, openLlmAudit, gatherAmbientInput, loadOrGenerateDeviceId, presentLine, readRoutes, renderBrief, shownPayload, stepsOf, turnBrief } from '@sundial/harness-runtime/index.js'
import { existingDefaultRoots, lastBackfill, planBackfill, runBackfill } from '@sundial/harness-runtime/backfill.js'
import { sendAppCommand, watchAppEvents } from '@sundial/harness-runtime/app-channel.js'
import { installLastGoodLookup } from '@sundial/helpers/dns-last-good.js'
import { loadSundialEnv } from '@sundial/helpers/sundial-env.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { benchSetup } from '@sundial/helpers/bench-guard.js'

export const name = 'sundial-kernel'
// W1 step 7: the nightly conversation pass reads the log's `chat:owner` rows, not dsh's session store.
export const inject = ['gnomonDb', 'gnomonMemory']


const CLOCK_TICK_INTERVAL_MS = 60_000

/**
 * One minute of the clock: a wall-clock `clock:tick`, unless this install is the bench and its marker holds the clock
 * (`bench.json` `holdClock`, lab/bench/longmemeval). There a wall-clock tick between two backdated ones is a day boundary
 * of its own and moves the conversation pass's cursor to now, so the backdated ticks the bench writes must be the only ones.
 * `benchSetup` is null on every other install (helpers bench-guard.ts), so the owner's clock always ticks. Read each minute,
 * so the bench switches it with no restart. True when it ticked.
 */
export async function tickUnlessHeld(runtime, setup = benchSetup) {
  if (setup()?.holdClock === true) return false
  await runtime.tickClock()
  return true
}

/**
 * `gnomonKernel.brief`, over anything with `getState` and `appendSignal` (exported for its test).
 * The ambient memory is read here, once per turn (W1 step 5: no timer, no cache);
 * `sections` are the other plugins' blocks (the board), read from the same state; `routes` reads what worked
 * before on screen from the log (`read/routes.ts`) for the apps of this turn.
 * `recorded` settles once `chat:shown` has folded, for a caller that reads the cause back.
 *
 * A chat is told each unchanged part of its brief once: `sent` remembers, per
 * session, each brief it was given as `[fingerprint of the brief's text, ...fingerprints
 * of the parts that brief carried]`, so the parts in its history are the union. A
 * compaction removes some briefs from the history and keeps others (sundial-actions keeps
 * the chat's first brief, Set 2 Round 2 item 3), so `kept()` (on `compaction/end`)
 * keeps the rows whose text is still there and the next brief re-sends only what left.
 * A work brief is not remembered: a job can hand its brief to a helper in another
 * session, and the work session never sees it.
 */
const fingerprint = (part) => createHash('sha1').update(part).digest('base64url').slice(0, 16)
const MAX_GIVEN_SESSIONS = 24
const MAX_BRIEFS = 80
/** A store written before the per-brief rows: one row whose text is unknown, dropped at the next compaction. */
const rowsOf = (saved) => (Array.isArray(saved) && saved.every((x) => typeof x === 'string') ? [['', ...saved]] : Array.isArray(saved) ? saved : [])

export function briefFor(runtime, { now = Date.now, gather = (state) => gatherAmbientInput({ state }), sections = () => [], routes = async () => [], store = null } = {}) {
  const warn = (what) => (error) => console.warn(`[sundial-kernel] ${what}: ${error instanceof Error ? error.message : String(error)}`)
  // Kept on disk (`store`): held only in memory, every restart re-sent the whole ~12k-character memory into a
  // history that still had it (lab/chat).
  const sent = new Map(Object.entries(store?.load() ?? {}).map(([id, saved]) => [id, rowsOf(saved)]))
  const save = () => store?.save(Object.fromEntries([...sent].slice(-MAX_GIVEN_SESSIONS)))
  const brief = async (input) => {
    const state = runtime.getState()
    const memory = await Promise.resolve().then(() => gather(state)).catch((error) => (warn('ambient memory not read')(error), null))
    const learned = await Promise.resolve().then(() => routes(state, input)).catch((error) => (warn('learned routes not read')(error), []))
    const shown = turnBrief(state, memory, input, now(), learned)
    const briefId = `brief-${randomUUID()}`
    const recorded = Promise.resolve(runtime.appendSignal('chat:shown', shownPayload(shown, briefId))).catch(warn('chat:shown not recorded'))
    const parts = await sections(state, input)
    const rows = shown.cause.kind === 'work' ? null : (sent.get(input.sessionId) ?? [])
    const remembered = rows ? new Set(rows.flatMap(([, ...prints]) => prints)) : null
    const text = renderBrief(shown, parts, remembered ? { has: (part) => remembered.has(fingerprint(part)) } : undefined)
    if (rows) {
      const carried = briefParts(shown, parts).map(fingerprint).filter((print) => !remembered.has(print))
      sent.delete(input.sessionId) // most recently briefed last, so the oldest session is the one dropped
      sent.set(input.sessionId, [...rows, [fingerprint(text), ...carried]].slice(-MAX_BRIEFS))
      save()
    }
    return { briefId, text, present: presentLine(shown), recorded }
  }
  /** One session's history was rewritten (compaction) and holds these message texts now: keep the briefs still in it. */
  brief.kept = (sessionId, texts) => {
    const held = new Set(texts.map(fingerprint))
    const rows = (sent.get(sessionId) ?? []).filter(([print]) => held.has(print))
    if (rows.length > 0) sent.set(sessionId, rows)
    else sent.delete(sessionId)
    save()
  }
  /** Brief that session whole next turn. No id: every session. */
  brief.forget = (sessionId) => {
    if (typeof sessionId === 'string') sent.delete(sessionId)
    else sent.clear()
    save()
  }
  return brief
}

/** The text of every user message on a dsh session's surface (what its history holds now). */
export const surfaceTexts = (session) =>
  (session?.surface?.nodes ?? [])
    .map((seq) => session.eventAt?.(seq))
    .filter((event) => event?.type === 'user/message')
    .map((event) => (event.data?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''))

export async function apply(ctx, config = {}) {
  // ~/.sundial/.env → process.env (SUNDIAL_LLM_BASE_URL/MODEL/API_KEY for the
  // effect executor's purpose calls via @sundial/llm). Existing process.env
  // values win; values are never logged.
  loadSundialEnv()
  // Process-wide: every plugin's model call, the chat's included, rides out a DNS failure on the last good address.
  installLastGoodLookup()
  // A kernel purpose on a provider the raw fetch cannot speak to (Anthropic messages, OpenAI
  // responses) goes through dsh's adapters: the same routes and credentials the chat uses.
  ctx.effect(() => {
    setModelPort(dshModelPort(ctx))
    return () => setModelPort(null)
  }, 'sundial-kernel model port')

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
      tickUnlessHeld(runtime).catch((error) => console.error('[sundial-kernel] clock tick failed:', error))
    }, config.clockTickIntervalMs ?? CLOCK_TICK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'sundial-kernel clock:tick')

  // Plan 15, 2.2: what the owner did in the app (a voice answer, a summon) reaches the fold through the one ingest.
  ctx.effect(() => {
    const watch = watchAppEvents((type, payload, ts) => {
      runtime.appendSignal(type, payload, ts).catch((error) => console.error(`[sundial-kernel] ${type} from the app not recorded:`, error))
    })
    return () => watch.stop()
  }, 'sundial-kernel app channel')

  // W1: blocks other plugins add to every brief (the board, from sundial-tools). Service wiring, not fold state.
  const sections = new Set()
  // Run 8 (2026-11-13): with every address shown as [email], Gnomon searched a browser's login store for the owner's own.
  sections.add(() => {
    const mails = loadSundialConfig().ownerEmails
    return mails.length ? `The owner's own email addresses ("me", "myself"): ${mails.join(', ')}. Never search files or browser data for an address.` : ''
  })
  // Real use (2026-11-13): 60 s went on the wrong browser space and 65 s on a note the vault's own URL would have written.
  sections.add(() => {
    const notes = loadSundialConfig().appNotes
    return notes.length ? `About the owner's own apps (they wrote this; a look cannot tell you):\n${notes.map((note) => `- ${note}`).join('\n')}` : ''
  })
  // Round 5: what Gnomon's self-review proposed and the owner kept: app notes, and routes kept as skills, by name.
  sections.add((state) => {
    const review = state?.selfReview
    const lines = [...(review?.notes ?? []).map((n) => `- ${n.app}: ${n.line}`), ...Object.entries(review?.skills ?? {}).filter(([, s]) => !s.rig).map(([name, s]) => `- skill ${skillLabel(s.app, name, s.routeKey)} in ${s.app}: ${s.routeKey}`)]
    return lines.length ? `What you learned from your own failed steps, and the owner kept:\n${lines.join('\n')}` : ''
  })
  // A section may read the owner's words (`input.text`) and may be async.
  const briefSections = async (state, input) => (await Promise.all([...sections].map(async (fn) => { try { return await fn(state, input) } catch { return '' } }))).filter((text) => typeof text === 'string' && text !== '')

  const givenFile = join(getSundialRuntimeDir(), 'brief-given.json')
  const store = {
    load: () => { try { return JSON.parse(readFileSync(givenFile, 'utf8')) } catch { return {} } },
    save: (value) => { try { mkdirSync(dirname(givenFile), { recursive: true }); writeFileSync(givenFile, JSON.stringify(value), { mode: 0o600 }) } catch (error) { console.warn(`[sundial-kernel] brief memory not saved: ${error instanceof Error ? error.message : String(error)}`) } },
  }
  // What worked before on screen, from the log, for the apps the message names or the owner is in.
  const routes = (state, input) => readRoutes({ state, text: input?.text, sessionId: input?.sessionId, steps: (app) => stepsOf(ctx.gnomonDb.queries, app, Date.now()) })
  const brief = briefFor(runtime, { sections: briefSections, routes, store })
  // Compaction rewrote THAT session's history: the next brief re-sends what is no longer in it. dsh appends
  // `compaction/end` to the session — it reaches a plugin as a session event, never as its own
  // ctx event (the old `ctx.on('compaction/end')` never fired, so a compacted chat lost its memory parts).
  ctx.on('session/event', (session, event) => { if (event?.type === 'compaction/end' && typeof session?.id === 'string') brief.kept(session.id, surfaceTexts(session)) })

  ctx.provide('gnomonKernel', {
    /** Append one signal: sanitize → signals log → reduce(RULE_MANIFEST) → effects. Serialized. */
    appendSignal: (type, payload, ts) => runtime.appendSignal(type, payload, ts),
    /** Plan 15, 2.2: one command for Sundial.app (`{ type, ... }`), e.g. a sentence of a spoken reply. */
    appChannel: { send: (command) => sendAppCommand(command) },
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
