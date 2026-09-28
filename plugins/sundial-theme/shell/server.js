// Gnomon's own client, served at `/`.
//
// WHY THIS EXISTS. Everything Gnomon had drawn until now was a tenant inside
// dsh's React app: a slot here, a DOM edit there, a MutationObserver to put it
// back when React undid it, and geometry written against class names that are
// content-hashed per build. That buys the conversation renderer for free and
// pays for it by never being able to change the shape of the thing — the chat
// is the page, and a surface is a widget inside a message.
//
// The seam that makes leaving cheap is in dsh's own web server, which describes
// itself as knowing "no harness concepts" and serving "no files": it is a bare
// route registry, and dsh's SPA is simply whoever claimed the FALLBACK seat. A
// named `exact: '/'` route is matched before that fallback, so Gnomon's page
// becomes the product at `/` without patching a bundle, without disabling a
// plugin, and without a second port. dsh's own assets stay served and unused;
// nothing serves its index any more, so its client never boots.
//
// WHAT IS KEPT. All of it, and it is the whole reason this is worth doing:
// `ctx.agents` (the turn loop), `ctx.sessionQuery` (the durable log),
// `ctx.tools`, the LLM adapters and model routing, `approval/request`, and
// Gnomon's own kernel, rules and memory. This file is a view over services that
// already exist. It implements no agent, no tool, and no policy.
//
// THE ONE CONTRACT. The client renders a session by reading the append-only
// session log through `frames.js`. `SessionEventMap` is the harness's DURABLE
// format — the thing it promises to be able to replay — which makes it a far
// more stable thing to build a UI on than the internals of somebody's React
// tree.
import { guard, guardPage } from './guard.js'
import { readdirSync } from 'node:fs'
import { getSundialHome } from '@sundial/helpers/config.js'
import { isHttpUrl, isLocalUrl, parseProviders, providerKeyEnv, providerLabel, setEnvValues } from '@sundial/helpers/llm-providers.js'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
const execFileP = promisify(execFile)
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { threadModelOf } from './thread-model.js'
import { boundContextSummary, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TOOL_REGISTRY, executeGnomonTool } from '@sundial/kernel/tools/index.js'
import { liveFrames, replayFrames, streamFrames, titleFrom } from './frames.js'
import { nowLine, nowSnapshot } from './now.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getSignalFreshness } from '@sundial/db/index.js'
import { SERVICES, allowed, describe, setPath } from './services.js'
import { forget, readArchive, setArchived } from './archive.js'
import { readTitles, writeTitles } from './session-titles.js'
import { entityId as makeEntityId } from './entity-id.js'
import { inputPage, watchPage } from '../../sundial-web-browser/page-session.js'

/** The session the proactive plugin speaks into. Its words are surfaced, never re-routed. */
const COMPANION_SESSION_ID = 'gnomon-companion'

/**
 * The projection units the sidebar reads, and the only ones it asks for: a
 * selected read views those rows and leaves every other unit's wire value
 * unproduced.
 */
const LIST_PROJECTIONS = ['title', 'sessionListMetadata', 'turnOutline']

/**
 * Sessions Gnomon itself owns. Archivable — the owner may hide them — but NEVER
 * deletable through this shell, live or not.
 *
 * The first version guarded only a LIVE agent. Both of these are built lazily
 * (the companion on its first notice, the ask agent on its first question), so
 * after a restart neither is live, `ctx.agents.get()` finds nothing, and the
 * guard let a delete through. It deleted them. The companion's transcript —
 * every unprompted thing Gnomon had said and every reply — was lost to a test
 * that expected a refusal. Ownership is a property of the id, not of whether
 * the process happens to have woken it yet.
 */
const OWN_SESSIONS = new Set([COMPANION_SESSION_ID])

/**
 * How long changed table names are gathered before one `stale` frame goes out.
 *
 * The fold already coalesces per tick; this is the second, coarser bucket, so a
 * burst of folds (a replay, a nightly pass) costs one frame a second rather
 * than one per event. Short enough that the board still reads as live.
 */
const STALE_WINDOW_MS = 1_000

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = 'sundial-shell'

/** A turn that produces nothing for this long has stopped being a turn. */
/** How much of a side thread rides into the conversation when it is brought in. */
const BRING_CHARS = 6000
const TURN_IDLE_MS = 240_000

/** Above the attachment store's own default per-image ceiling, so its validator is what refuses and says why. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Per turn. The store allows twenty per message; a chat composer wants far fewer. */
const MAX_IMAGES_PER_TURN = 4

/** A manual compaction summarizes the transcript with one model call; past this it has failed rather than being slow. */
const COMPACT_TIMEOUT_MS = 180_000

/** An unanswered approval expires rather than holding a tool call forever. */
const APPROVAL_TTL_MS = 300_000

/**
 * A presented file this big is not something to push through a browser tab —
 * the route reads it into memory to send it, and a deliverable is meant to be
 * a result, not a dataset. Past this the owner is told where it is instead.
 */
const MAX_DELIVERABLE_BYTES = 64 * 1024 * 1024

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/**
 * Every servable file in this directory, by route.
 *
 * This was a hand-written list of seventeen entries, and a new module that was
 * not added to it 404'd with no error anywhere but the browser's console — the
 * page simply stopped booting. The names now come from the directory itself,
 * read once at load, which is also why there is no traversal to guard: a
 * request never contributes a path component. `.test.js` files are not part of
 * the client, and `index.html` has its own route at `/`.
 *
 * Adding a module is a host-side change, so it needs the restart a host-side
 * change needs anyway; editing one is still picked up by a plain reload.
 */
const ASSETS = Object.fromEntries(
  readdirSync(HERE)
    .filter((name) => TYPES[extname(name)] !== undefined && !name.endsWith('.test.js'))
    .map((name) => [`/gnomon/app/${name}`, [name, TYPES[extname(name)]]]),
)

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read one JSON body, bounded. A request larger than this is not a message. */
async function readBody(req, limit = 262_144) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) throw new Error('too large')
  }
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Mount the shell.
 *
 * @param ctx the plugin context — needs webServer, agents, agentDefaultModel,
 *   sessionQuery, sessions.
 * @param cwd the working directory new sessions are created in.
 */
export function mountShell(ctx, { cwd = process.cwd(), home = getSundialHome() } = {}) {
  // Every route goes through the fence (shell/guard.js): a same-origin, signed-in browser, or this process.
  const registerRoute = (route) => ctx.webServer.register(guard(ctx.connection, route))
  // ── Live streams ────────────────────────────────────────────────────────
  // One entry per session with at least one browser watching it. A Set rather
  // than a single writer because two windows on the same session is a normal
  // thing to do and should not make one of them go blind.
  const streams = new Map()

  const watch = (sessionId, emit) => {
    const set = streams.get(sessionId) ?? new Set()
    set.add(emit)
    streams.set(sessionId, set)
    return () => {
      set.delete(emit)
      if (set.size === 0) streams.delete(sessionId)
    }
  }

  const push = (sessionId, frame) => {
    for (const emit of streams.get(sessionId) ?? []) emit(frame)
  }

  // Sessions with an owner's POST turn streaming right now. The standing watch
  // (`/gnomon/api/watch`) stays quiet for them, because that POST already
  // carries every frame of the session to the same browser.
  const turning = new Map()
  const turnOpened = (id) => turning.set(id, (turning.get(id) ?? 0) + 1)
  const turnClosed = (id) => {
    const left = (turning.get(id) ?? 1) - 1
    if (left > 0) turning.set(id, left)
    else turning.delete(id)
  }

  // One decoded log per session, kept until that session writes again. The
  // companion's log is 3.9 MB of zstd and every open decoded it TWICE (the
  // replay and the model picker's `rememberedModel`), ~0.25 s each on a thread
  // the whole board shares. `session/event` fires for every append, and this
  // process is the only writer, so a kept snapshot can never be stale.
  const snapshots = new Map()
  const readSnapshot = (id) => {
    let snapshot = snapshots.get(id)
    if (snapshot === undefined) {
      snapshot = ctx.sessionQuery.readSession(SessionId(id))
      snapshot.catch(() => snapshots.get(id) === snapshot && snapshots.delete(id))
      snapshots.set(id, snapshot)
      // A handful of threads is all anyone flips between; the oldest goes.
      if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value)
    }
    return snapshot
  }
  ctx.effect(() => ctx.on('session/event', (session) => session?.id !== undefined && snapshots.delete(session.id)))
  // Decoded now, off the owner's clock: the first page load after a restart
  // would otherwise pay the whole decode while the board is also reading.
  setTimeout(() => readSnapshot(COMPANION_SESSION_ID).catch(() => {}), 5_000).unref?.()

  // Every session in the process reports here. Frames go to whoever is watching
  // that session and nowhere else — a stream is per session, never per request,
  // which is what makes a second window work and what lets an approval reach a
  // browser mid-turn.
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      const id = session?.id
      if (id === undefined || !streams.has(id)) return
      for (const frame of liveFrames(event)) push(id, frame)
    }),
  )

  // The model's prose, which is NOT in the session log while it streams. dsh
  // 0.1.5 split the transient stream off the durable one: chunks are published
  // process-locally here, and only the settled `assistant/message` is logged.
  // Same `StreamChunk` payload as the retired `assistant/chunk` event, one
  // envelope further out.
  ctx.effect(() =>
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const id = agent?.session?.id
      if (id === undefined || !streams.has(id)) return
      for (const out of streamFrames(frame)) push(id, out)
    }),
  )

  // ── Stopping one tool call ──────────────────────────────────────────────
  // `tools/execute` wraps every tool body, so this is the one seam that can end
  // a single call without cancelling the turn around it. The call gets a signal
  // of its own fused into the one dsh handed it; Stop aborts it and answers the
  // model at once — a body that ignores its signal (a page load) is left to
  // finish in the background, its result dropped, because the owner asked for
  // the turn back NOW. The model reads why and carries on without it.
  const stoppers = new Map()
  ctx.effect(() =>
    ctx.on('tools/execute', async (exec, next) => {
      const callId = exec?.callId
      if (typeof callId !== 'string' || callId === '') return next()
      const controller = new AbortController()
      const prior = exec.signal
      exec.signal = prior ? AbortSignal.any([prior, controller.signal]) : controller.signal
      stoppers.set(callId, controller)
      const stopped = new Promise((resolve) =>
        controller.signal.addEventListener(
          'abort',
          () => resolve({ content: [{ type: 'text', text: 'Error: the owner stopped this tool call while it was running. Carry on without its result, and do not run it again unless they ask.' }], isError: true, error: { message: 'stopped by the owner' } }),
          { once: true },
        ),
      )
      try {
        return await Promise.race([next(), stopped])
      } finally {
        stoppers.delete(callId)
        exec.signal = prior
      }
    }),
  )

  // ── Questions with choices ──────────────────────────────────────────────
  // `ask_user_question` (dsh-tool-ask-user) waits on the `user-questions/request`
  // waterfall. Answered here — prepended, for the same reason as approvals
  // below: dsh-api-remotes would otherwise queue it for a client that never
  // boots. The chat draws the question from the TOOL CALL (it is in the log,
  // so replay shows it); this only holds the call open until the owner taps,
  // one pending question per session, since the call blocks its turn.
  const openQuestions = new Map()
  ctx.effect(() =>
    ctx.on(
      'user-questions/request',
      async (req, next) => {
        const sessionId = req?.agent?.session?.id
        if (sessionId === undefined || !holds(sessionId)) return next()
        const questions = Array.isArray(req.questions) ? req.questions : []
        return await new Promise((resolve) => {
          const settle = (answers) => {
            if (openQuestions.get(sessionId) !== settle) return
            openQuestions.delete(sessionId)
            req.signal?.removeEventListener?.('abort', onAbort)
            resolve({ answers })
          }
          // A cancelled turn withdraws the question: every item unanswered.
          const onAbort = () => settle(questions.map((q) => ({ id: String(q.id), selected: [] })))
          req.signal?.addEventListener?.('abort', onAbort, { once: true })
          openQuestions.set(sessionId, settle)
        })
      },
      { prepend: true },
    ),
  )

  // ── Approvals ───────────────────────────────────────────────────────────
  // `approval/request` is a waterfall, so claiming it is the supported way to
  // be the answerer. This is the seam the Ask layer did not have: without an
  // answerer of our own, a gated tool call hung until it timed out, and the
  // only surface that could draw the prompt was dsh's chat.
  //
  // We answer ONLY for a session someone is actually watching. With no browser
  // on it there is no human to ask, so `next()` hands the question back to the
  // chain and lets it reach its own fail-closed default rather than inventing
  // an answer nobody gave.
  //
  // `prepend` puts us at the FRONT of the waterfall, and that is load-bearing.
  // dsh 0.1.5 added `approval/request` to `dsh-api-remotes`'s forwarded-event
  // allowlist: a listener registered by `dsh-web-app` — which loads ahead of
  // this plugin — claims the question and queues it for a connected remote
  // client. Gnomon serves `/` itself, so dsh's own client never boots and never
  // answers; the queued question resolved never, and a gated call hung forever
  // with no prompt anywhere. Answering first keeps that path intact for anyone
  // who does run dsh's client: an unwatched session still falls through to it.
  const pending = new Map()
  /** approval id → { sessionId, frame }: what a browser opening that thread later still has to be asked. */
  const waiting = new Map()
  /**
   * Whose questions this shell holds even with no browser on them: the owner's
   * own threads (`session-<uuid>`, minted here) and the conversation. A turn
   * nobody typed — a helper's report waking a thread — used to ask into the
   * void and hang; now it waits, and the thread shows the question when opened.
   * A helper's own session (a bare uuid) is not the owner's, and falls through.
   */
  const holds = (id) => streams.has(id) || id === COMPANION_SESSION_ID || id.startsWith('session-')

  ctx.effect(() =>
    ctx.on(
      'approval/request',
      async (req, next) => {
        const sessionId = req?.agent?.session?.id
        if (sessionId === undefined || !holds(sessionId)) return next()

        const id = `approval-${randomUUID()}`
        return await new Promise((resolve) => {
          const settle = (outcome) => {
            if (!pending.has(id)) return
            pending.delete(id)
            waiting.delete(id)
            clearTimeout(timer)
            req.signal?.removeEventListener?.('abort', onAbort)
            push(sessionId, { type: 'approval-closed', id, outcome })
            resolve(outcome)
          }
          const timer = setTimeout(() => settle('rejected'), APPROVAL_TTL_MS)
          // The asker withdrew the question (the turn was cancelled). Settle
          // 'cancelled' so the audit records what actually happened rather than
          // a refusal the owner never gave.
          const onAbort = () => settle('cancelled')
          req.signal?.addEventListener?.('abort', onAbort, { once: true })

          pending.set(id, settle)
          const frame = {
            type: 'approval',
            id,
            toolName: String(req.toolName ?? 'a tool'),
            callId: req.callId === undefined ? null : String(req.callId),
            reason: typeof req.reason === 'string' ? req.reason : null,
          }
          waiting.set(id, { sessionId, frame })
          push(sessionId, frame)
        })
      },
      { prepend: true },
    ),
  )

  // ── The live channel ────────────────────────────────────────────────────
  // One long-lived stream per open browser, carrying everything that is NOT a
  // reply to something the owner said: what they are doing right now, what
  // Gnomon decided to say unprompted, and the question it is waiting on.
  //
  // This is the seam that was missing. The proactive plugin has been speaking
  // for weeks — into a companion session nobody had open. Its words, its
  // timing, its judgement about when to interrupt all existed; the owner just
  // had to go and find the room. Now the room comes to them.
  //
  // Read-only over the proactive plugin: nothing here decides, routes or
  // cancels. It watches the companion's session log and repeats what landed.
  const live = new Set()
  const broadcast = (frame) => {
    for (const emit of live) emit(frame)
  }
  const snapshot = () => nowSnapshot(ctx.gnomonKernel.getState())
  const openAsk = () => {
    const open = ctx.gnomonKernel.getState().ownerAsk?.open ?? null
    return open === null
      ? null
      : { askId: open.askId, question: open.question, reason: open.reason === '' ? null : open.reason, choices: Array.isArray(open.choices) ? open.choices : [], waiting: open.waiting === true }
  }

  // A WAITING ask (gnomon_ask_owner with wait: true) has a turn paused on it,
  // so it cannot wait for the change frame below: the `ownerAsk` rule announces
  // it on its own Notify channel and the seat redraws at once.
  ctx.effect(() =>
    ctx.on('gnomon/notice', (notice) => {
      if (notice?.channel === 'ask-open') broadcast({ type: 'ask', open: openAsk() })
      // A job opened: the strip should say so now, not at the next pulse.
      if (notice?.channel === 'work-job') broadcast({ type: 'now', now: snapshot() })
    }),
  )

  // The board, the moment it changes — by Gnomon's hand (gnomon_board emits)
  // or the owner's (the route below emits the same event).
  ctx.effect(() => ctx.on('gnomon/board', (board) => broadcast({ type: 'board', board })))
  // The settings, the moment they change: every open tab obeys the same ones.
  ctx.effect(() => ctx.on('gnomon/settings', (settings) => broadcast({ type: 'settings', settings })))

  // A running job's plan, relayed from the proactive plugin (see work.js). The
  // strip shows "step k of n" from it.
  ctx.effect(() => ctx.on('gnomon/working', ({ jobId, todos }) => broadcast({ type: 'working', jobId, todos })))

  // The live channel's heartbeat, which is no longer a heartbeat.
  //
  // This used to be a 30-second pulse that broadcast the present and made every
  // visible card re-read, whether or not anything had moved — 29 reads on one
  // SQLite thread, twice a minute, forever. The kernel now names the tables
  // each fold wrote (`gnomon/changed` ← `tablesTouched`), so the channel speaks
  // only when the record does, and says WHICH readings moved. A card re-reads
  // its own reading or nothing at all.
  //
  // `state` is the fold's own shape rather than a table, so it carries the
  // present and the open question with it.
  ctx.effect(() => {
    let lastAsk = JSON.stringify(openAsk())
    /** Tables gathered since the last frame; drained by the timer below. */
    const pending = new Set()
    let timer = null

    const flush = () => {
      timer = null
      const tables = [...pending]
      pending.clear()
      if (tables.length === 0 || live.size === 0) return
      broadcast({ type: 'stale', tables })
      // The present is read from the fold, so any change may have moved it.
      broadcast({ type: 'now', now: snapshot() })
      const ask = JSON.stringify(openAsk())
      if (ask !== lastAsk) {
        lastAsk = ask
        broadcast({ type: 'ask', open: JSON.parse(ask) })
      }
    }

    const off = ctx.on('gnomon/changed', (tables) => {
      if (live.size === 0) return
      for (const table of tables) pending.add(table)
      if (timer === null) timer = setTimeout(flush, STALE_WINDOW_MS)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  })

  /** The key of the notice that most recently woke the companion; stamped on its next words. */
  let lastNoticeKey = null
  /** The ask id that notice carried, when it was a question — so the words bind to THAT ask, not to whichever is open when they land. */
  let lastAskId = null

  // What Gnomon said unprompted. The companion's own assembled reply is the
  // thing worth showing — the notice that provoked it is the reason, and the
  // reply is what a colleague would actually have said.
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (session?.id !== COMPANION_SESSION_ID) return
      if (event?.type === 'user/message' && event.data?.source?.kind === 'plugin' && event.data.source.form === 'notice' && !/^Brought in: /.test(event.data.source.summary ?? '')) {
        // The observation that woke it — visible the moment it lands, before
        // the model has finished deciding how to put it. The notice's key rides
        // along, so the block the words land in can carry a verdict back to
        // exactly this notice (`/gnomon/api/feedback`).
        const text = liveText(event.data)
        lastNoticeKey = text.match(/^Notice key: (.+)$/m)?.[1]?.trim() ?? null
        lastAskId = text.match(/^Ask id: (.+)$/m)?.[1]?.trim() ?? null
        if (text !== '') broadcast({ type: 'noticed', text: text.split('\n')[1] ?? text, at: new Date().toISOString(), noticeKey: lastNoticeKey })
      }
      // The owner's own turn is already streaming to them on its POST; only a
      // turn nobody typed is "said" unprompted. Broadcasting both drew every
      // answer in the conversation twice.
      if (event?.type === 'assistant/message' && !turning.has(COMPANION_SESSION_ID)) {
        const text = liveText(event.data.message)
        // Tagged with the question that is open at this moment, when there is
        // one. The companion asks with gnomon_ask_owner and then phrases the
        // question in prose; the prose is what the owner sees, and it needs to
        // know which askId it belongs to so it can SETTLE when that question is
        // answered anywhere — in the seat, in the chat, or by expiring.
        // The notice's own ask id first; the open ask only when the notice
        // carried none (a question the companion asked in prose on its own).
        if (text.trim() !== '') broadcast({ type: 'said', text, at: new Date().toISOString(), session: COMPANION_SESSION_ID, askId: lastAskId ?? openAsk()?.askId ?? null, noticeKey: lastNoticeKey })
      }
    }),
  )

  function liveText(message) {
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /** The model this deployment is on, as both the agent options and a label. */
  const selection = () => ctx.agentDefaultModel.currentSelection()

  /**
   * The live agent for one session, resumed from its log when it is not already
   * running in this process. Three tiers, the same shape the proactive
   * companion uses: live, resumed, created.
   */
  // The dispose function of every agent THIS shell brought to life. dsh's
  // registry can find a live agent but cannot end one — only the handle that
  // created it can — so deleting a session means having kept its handle. An
  // agent someone else created (the companion, the ask channel) is not ours
  // to end, and deletion says so rather than pulling files out from under it.
  const handles = new Map()

  /**
   * Each live thread's own model (J1.10). dsh's `ModelSelectionRef.current`
   * is mutable and read at the next step, so a thread can switch models
   * mid-conversation without a new agent; the shell used to hand dsh a fresh
   * ref and forget it, which left the picker able to change only the default
   * for NEW threads. The default stays `qwen3.8-flash-next` for every purpose
   * (owner decision, 2026-09-22); a thread that chose otherwise keeps it
   * across a restart because its own log says which route served it.
   */
  const threadModels = new Map()
  const threadModel = (sessionId) => threadModels.get(sessionId)?.current ?? null

  async function rememberedModel(id) {
    try {
      const snapshot = await readSnapshot(id)
      return threadModelOf(snapshot.events)
    } catch {
      return null
    }
  }

  async function agentFor(sessionId, { create = false } = {}) {
    const id = SessionId(sessionId)
    const live = ctx.agents.get(id)
    if (live !== undefined && live.status !== 'disposed') return live

    const current = threadModel(sessionId) ?? (create ? null : await rememberedModel(id)) ?? selection()
    const ref = threadModels.get(sessionId) ?? { current, assembled: undefined }
    ref.current = current
    threadModels.set(sessionId, ref)
    const agentOptions = { provider: current.provider, model: current.model }
    // Without this the session carries no model selection, and the picker has
    // nothing to show or change.
    //
    // A BLOCK body, deliberately: dsh treats whatever `setup` returns as an
    // `AgentSetupCommit` and calls `.commit()` on it. `installModelSelection`
    // returns something else, so an expression-bodied arrow hands that value
    // over and every turn dies on "?.commit is not a function".
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, ref)
      // The Gnomon preset (todo_write, skills). Resolved at call time like every
      // optional dsh service here: no roster means the agent runs as before.
      await ctx.get?.('agentPresets')?.mount(agentCtx, 'gnomon')
    }

    // Resume when the log exists, create when it does not. The fall-through
    // matters for Gnomon's own sessions: press "Reply" on an unprompted block
    // after the companion's log is gone (it was deleted once, this afternoon)
    // and a bare resume fails with "not found" — the owner asked to talk to
    // Gnomon, and a missing file is not a reason to refuse them.
    let handle
    if (create) {
      handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
    } else {
      try {
        handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions, setup })
      } catch (error) {
        if (!/not found/i.test(error instanceof Error ? error.message : String(error))) throw error
        console.log(`[${PLUGIN}] session ${sessionId} has no log; creating it`)
        handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
      }
    }
    if (typeof handle.dispose === 'function') handles.set(sessionId, handle.dispose)
    return handle.agent
  }

  // ── The page ────────────────────────────────────────────────────────────
  // Read from disk per request rather than cached in memory. There is no build
  // step for this client on purpose — it is one page — and reading the file
  // means a reload picks up an edit, which is the whole development loop.

  const serveFile = (path, type) =>
    ctx.effect(() =>
      registerRoute({
        kind: 'exact',
        path,
        handler: async (_req, res) => {
          try {
            const body = await readFile(join(HERE, type[0]))
            // Code is read fresh per request (the development loop); a photo is not.
            res.writeHead(200, { 'content-type': type[1], 'cache-control': type[1].startsWith('image/') ? 'max-age=86400' : 'no-store' })
            res.end(body)
          } catch (error) {
            console.error(`[${PLUGIN}] ${path}: ${error instanceof Error ? error.message : String(error)}`)
            res.writeHead(500).end()
          }
        },
      }),
    )

  // `exact: '/'` is matched before the fallback seat dsh's own SPA claims, so
  // this one line is the whole takeover. Nothing is patched and nothing is
  // disabled: dsh's index simply stops being reachable.
  // The two pages take the launch-token exchange (`/?token=…` → cookie), so the
  // URL `sundial open` prints signs a browser in once.
  const servePage = (path, file) =>
    ctx.effect(() =>
      ctx.webServer.register(
        guardPage(ctx.connection, {
          kind: 'exact',
          path,
          handler: async (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(await readFile(join(HERE, file)))
          },
        }),
      ),
    )
  servePage('/', 'index.html')
  servePage('/setup', 'setup.html')
  for (const [path, asset] of Object.entries(ASSETS)) serveFile(path, asset)

  // ── The API ─────────────────────────────────────────────────────────────

  const api = (path, handler) =>
    ctx.effect(() =>
      registerRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
          } catch (error) {
            console.error(`[${PLUGIN}] ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) sendJson(res, 500, { unavailable: 'Gnomon could not answer that.' })
            else if (!res.writableEnded) res.end()
          }
        },
      }),
    )

  /**
   * One session's list facts WITHOUT reading its log.
   *
   * dsh 0.1.5 persists every projection unit's fold to `~/.dsh/storages`, and
   * `cachedSnapshot` is that cache's zero-I/O listing read: synchronous, off
   * the storage domain's in-memory state, as stale as the last checkpoint but
   * never wrong (the header is the identity witness, so a recreated id cannot
   * be served another log's state).
   *
   * `inheritedEventCount` completes the checkpoint identity and is Session
   * state, not header metadata, so it is not on a listed record. A session
   * that is not a fork has none — the offset is exactly 0 — and a seeded one
   * skips this rung rather than guessing a prefix length.
   *
   * Expect this to MISS for a while. 0.1.5 widened the cache's identity (it
   * now binds format version, seeding and inherited prefix as well as
   * createdAt and cwd), so every row written by rc.6 is correctly refused
   * rather than trusted, and a record only gains the new shape when its
   * session is next written. Nothing here can warm the other rows: the
   * sidebar reads and never writes. The batched path below is what has to be
   * fast, and this rung is the bonus that grows over time.
   */
  const listHint = (header) => {
    if (header.isSeeded === true) return null
    try {
      const snapshot = ctx.sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), LIST_PROJECTIONS)
      if (snapshot === undefined) return null
      const meta = snapshot.values.sessionListMetadata
      return {
        // `title` is the wire shape the list rows want already: a plain string
        // or null. A session Gnomon has spoken in since the upgrade also has a
        // turnOutline, whose first entry carries a bounded prompt preview —
        // a better name than the id for a thread the titler never got to.
        title: snapshot.values.title ?? snapshot.values.turnOutline?.[0]?.prompt ?? '',
        blank: meta?.blank === true,
        lastPromptAt: meta?.lastPromptAt ?? null,
      }
    } catch {
      // A cache that cannot answer is not an error, only a slower path.
      return null
    }
  }

  /** The sidebar: every session, newest first, named by something a human can read. */
  // A session that is not live is a closed file: its log cannot gain a word, so
  // the title read off it is the same answer every time. Only the answer is
  // kept, including the empty one — the corpus here is ~190 sessions and the
  // comment below explains that almost none of them yield a name, so it is the
  // fruitless reads that cost the second, and they are the ones worth not
  // repeating. A live session is never cached; it is still being written.
  //
  // Loaded from disk so it survives a restart: the first listing after login is
  // the one the owner actually waits on, and without this it paid the whole
  // ~1.5 seconds every single login. See session-titles.js for the safety rules.
  const titleMemo = readTitles(home)
  /** Written only when the map changed — a listing that learns nothing writes nothing. */
  const saveTitles = () => {
    try {
      writeTitles(home, titleMemo)
    } catch (error) {
      // A cache that cannot be written is a slower next boot, not a failure.
      console.error(`[${PLUGIN}] session titles could not be cached: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** This server just wrote to that session: whatever it was called may have changed. */
  const forgetTitle = (id) => {
    if (titleMemo.delete(id)) saveTitles()
  }

  api('/gnomon/api/sessions', async (_req, res) => {
    const records = await ctx.sessionQuery.listSessions()
    const archived = readArchive(home)

    const hints = new Map()
    for (const record of records) {
      const hint = listHint(record.header)
      if (hint !== null) hints.set(record.header.id, hint)
    }

    // Everything the cache could not answer, in ONE batched observation of the
    // corpus — `readTitleSnapshots` folds every requested session's title from
    // a single cancellable pass.
    //
    // This is where the four seconds were, and it was never one slow read: it
    // was the shape. A `readTitle` per session, and then, for each of the fifty
    // that came back empty, a read of that session's ENTIRE log to look for the
    // first thing the owner said.
    //
    // That second read is gone rather than batched. Measured over all 185
    // sessions here, it found a name in exactly ZERO of them: every session dsh
    // never titled has three or four events in it — created, never spoken in —
    // so the read was guaranteed waste, repeated on every single load. A
    // session that really does have words and no title is still named exactly,
    // just one step later: `/gnomon/api/session` derives the title from the
    // whole log when the owner opens it, and that read was happening anyway.
    const isLive = new Map(records.map((record) => [record.header.id, record.live === true]))
    // A live session's log is still growing, so anything remembered about it is
    // suspect — and a session Gnomon deleted should not keep a row in the file
    // for ever. Both are dropped before the cache is consulted.
    let changed = false
    for (const id of [...titleMemo.keys()]) {
      if (isLive.get(id) !== false && titleMemo.delete(id)) changed = true
    }

    const derived = new Map([...titleMemo])
    const cold = records.map((record) => record.header.id).filter((id) => !hints.has(id) && !titleMemo.has(id))
    if (cold.length > 0) {
      for (const result of await ctx.sessionQuery.readTitleSnapshots(cold)) {
        // Per-session failures are isolated by contract; such a row keeps the
        // id as its name, exactly as it did before. A failure is not memoised —
        // it says nothing durable about the file.
        if (result.status !== 'fulfilled') continue
        const title = result.value.title?.title?.trim() ?? ''
        if (title !== '') derived.set(result.sessionId, title)
        if (isLive.get(result.sessionId) === false) {
          titleMemo.set(result.sessionId, title)
          changed = true
        }
      }
    }
    if (changed) saveTitles()

    const rows = records.map((record) => {
      const header = record.header
      const id = header.id
      const hint = hints.get(id)
      return {
        id,
        title: hint?.title || derived.get(id) || '',
        createdAt: header.createdAt ?? null,
        live: record.live === true,
        // The thread's own model when it is live and chose one; null says "the default, as far as this list knows".
        model: threadModel(id)?.model ?? null,
        archived: archived.has(id),
        // Both come from the cache only, so they are hints and not facts about
        // every row. The client uses `blank` to say "empty" instead of
        // "Untitled session", which is the honest name for a thread with no
        // turn in it; a row without the hint keeps the old wording.
        blank: hint?.blank ?? null,
        lastPromptAt: hint?.lastPromptAt ?? null,
      }
    })
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    sendJson(res, 200, { sessions: rows, model: selection().model ?? null })
  })

  /**
   * Archive or restore. A UI fact, not a log fact: the sessions are untouched,
   * so this costs nothing and restoring is exact. See archive.js.
   */
  api('/gnomon/api/sessions/archive', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Archiving takes a POST.' })
      return
    }
    const body = await readBody(req, 65_536)
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    if (ids.length === 0) {
      sendJson(res, 400, { unavailable: 'Which sessions?' })
      return
    }
    const archived = setArchived(home, ids, body?.archived !== false)
    sendJson(res, 200, { archived: [...archived] })
  })

  /**
   * Delete — the one irreversible thing this shell does, so it is the one place
   * that refuses.
   *
   * A session with a live agent this shell created is disposed first, which
   * stops the driver and removes it from the store; then the backend's artefact
   * is removed through `locate()`, never by guessing a path. A session whose
   * live agent belongs to someone else — the companion, the ask channel — is
   * REFUSED with the reason: Gnomon is using it, and pulling its file out from
   * under an appending writer would corrupt the record it is mid-sentence in.
   */
  api('/gnomon/api/sessions/delete', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Deleting takes a POST.' })
      return
    }
    const body = await readBody(req, 65_536)
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) {
      sendJson(res, 400, { unavailable: 'Which sessions?' })
      return
    }

    for (const id of ids) snapshots.delete(id)
    const headers = new Map((await ctx.sessionQuery.listSessions()).map((record) => [record.header.id, record.header]))
    const deleted = []
    const refused = []

    for (const id of ids) {
      // Refused by IDENTITY, before anything is looked up. See OWN_SESSIONS.
      if (OWN_SESSIONS.has(id)) {
        refused.push({ id, reason: `${id} is Gnomon's own session. Archive it if you do not want to see it.` })
        continue
      }
      const live = ctx.agents.get(SessionId(id))
      if (live !== undefined && live.status !== 'disposed') {
        const dispose = handles.get(id)
        if (dispose === undefined) {
          refused.push({ id, reason: 'Another part of Gnomon is driving this session right now.' })
          continue
        }
        try {
          await dispose()
        } catch (error) {
          refused.push({ id, reason: `Could not close it: ${error instanceof Error ? error.message : String(error)}` })
          continue
        }
        handles.delete(id)
      }

      const header = headers.get(id)
      const location = header === undefined ? undefined : ctx.sessionPersistence.locate(header)
      if (location === undefined) {
        // Not on disk and not live: nothing to delete, and nothing to refuse.
        // The archive is still cleaned so it does not name a ghost.
        deleted.push(id)
        continue
      }
      try {
        // The jsonl backend keeps each session in its own directory named by
        // the id, with the artefact inside. Remove the directory when it IS the
        // session's own; otherwise only the artefact, so a shared directory is
        // never taken out with it.
        const target = location.path
        const parent = dirname(target)
        const isFile = (await stat(target)).isFile()
        await rm(isFile && basename(parent) === id ? parent : target, { recursive: true, force: true })
        deleted.push(id)
      } catch (error) {
        refused.push({ id, reason: `Could not remove it: ${error instanceof Error ? error.message : String(error)}` })
      }
    }

    if (deleted.length > 0) {
      forget(home, deleted)
      console.log(`[${PLUGIN}] deleted ${deleted.length} session(s)`)
    }
    sendJson(res, 200, { deleted, refused })
  })

  /** One session's whole transcript, as the frames that redraw it. */
  /**
   * The record, for the owner's own hands.
   *
   * Explore runs the SAME read tools the model reads the record through, so
   * what the owner sees on a pane and what Gnomon can say are one record read
   * two ways. Restricted to tools that declare themselves read-only, by the
   * registry's own flag rather than a list here — a new read tool is
   * explorable the day it exists, and a write tool never is.
   */
  api('/gnomon/api/read', async (_req, res, url) => {
    const name = url.searchParams.get('tool') ?? ''
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name)
    if (tool === undefined || tool.readOnly !== true) {
      sendJson(res, 404, { unavailable: 'Not a read tool.' })
      return
    }
    let args = {}
    try {
      args = JSON.parse(url.searchParams.get('args') ?? '{}')
    } catch {
      sendJson(res, 400, { unavailable: 'The arguments were not JSON.' })
      return
    }
    sendJson(res, 200, await executeGnomonTool(name, args))
  })

  /**
   * One search over everything Gnomon holds, answered twice: the hits, then a
   * reading of them.
   *
   * TWO CORPORA, ONE FIELD. The record (moments, facts, knowledge entries) and
   * the owner's own conversations with Gnomon are indexed by different
   * machinery and are deliberately not folded into one ranking — the retriever's
   * scoring was measured over the record, and mixing a literal text index into
   * it means re-measuring. They are searched together and shown apart, which is
   * also the truer reading: "what I did" and "what we said" are different kinds
   * of evidence and the owner should always know which they are looking at.
   *
   * WHY IT STREAMS. The searches are a linear scan and a text index — fast. The
   * reading is a model call and is not. One request that waited for both would
   * hold a list the owner could already have been reading. So this speaks the
   * same SSE grammar `/gnomon/api/live` and `/gnomon/api/turn` already do: a
   * `hits` frame the moment there are hits, a `reading` frame when the model
   * has answered, and `done`. No new concept, and no second route.
   *
   * WHY THE MODEL ONLY EVER SEES THE HITS. The reading is one bounded call over
   * the finalized result — not a turn, not an agent, no tools, no board
   * context, no transcript. It cannot search further, so it cannot cost more
   * than what is already on the owner's screen, and it cannot answer from
   * anything the owner is not also looking at. That second property is the
   * point: a reading that cites something absent from the list below it would
   * be unfalsifiable by the person reading it.
   *
   * It rides `ctx.llm.stream`, which means it passes through the SAME
   * `llm/stream` waterfall `gnomon-tools` installs — so it lands in `llm_audit`
   * and meters against the `ask` budget like every other call Gnomon makes.
   * Nothing here is off the ledger.
   */
  const SEARCH_RECORD_LIMIT = 12
  const SEARCH_CONVERSATION_LIMIT = 6
  /** One hit's text, on one prompt line. Long enough to carry a claim, short enough that 18 of them are still cheap. */
  const SEARCH_LINE_CHARS = 240
  /**
   * How long the reading may take before the card stops waiting for it.
   *
   * Not a guess: the ledger has this same call answering in 8 s and in 62 s,
   * and once hanging 516 s before the provider gave up on its own. The hits are
   * already on screen throughout, so the cost of cutting a slow reading short
   * is one sentence, and the cost of not cutting it is a card that says
   * "Reading…" until the owner reloads. Bound it.
   */
  const SEARCH_READING_TIMEOUT_MS = 45_000

  /**
   * The owner's own conversations, searched.
   *
   * dsh refuses a search when the set of live sessions moved between its two
   * observations and retries only once; under Gnomon's work loop a child
   * starting mid-search is an ordinary moment, not a fault. Same wait-it-out as
   * `gnomon_conversation_search`, which cannot be called from here: that tool
   * lives in dsh's registry, and this route reads the kernel's.
   *
   * A corpus that cannot be searched says so. It returns `{hits, unavailable}`
   * rather than an empty list, because a silently missing half of a GLOBAL
   * search is the one failure the owner cannot detect: "nothing was said about
   * this" and "the index would not open" draw identically as no rows, and only
   * one of them is a finding.
   */
  async function searchConversations(query) {
    if (typeof ctx.sessionQuery?.searchSessions !== 'function') return { hits: [], unavailable: 'This profile has no conversation index.' }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const page = await ctx.sessionQuery.searchSessions({ query, limit: SEARCH_CONVERSATION_LIMIT })
        // dsh answers `{items: [{header, bestMatch}]}` — one row per session,
        // carrying the single event that matched. `time` is epoch ms and `type`
        // is `<role>/<what>`; the view wants an ISO instant and a bare role.
        const items = Array.isArray(page?.items) ? page.items : []
        return {
          hits: items.map((item) => {
            const match = item?.bestMatch ?? {}
            return {
              sessionId: String(item?.header?.id ?? match.sessionId ?? ''),
              at: Number.isFinite(match.time) ? new Date(match.time).toISOString() : null,
              role: String(match.type ?? '').split('/')[0],
              excerpt: String(match.snippet ?? ''),
            }
          }),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt < 4 && /did not stabilize/.test(message)) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
          continue
        }
        console.error(`[${PLUGIN}] conversation search failed: ${message}`)
        // One unreadable session log takes the whole index down with it — the
        // same `unsupported descriptor version` that already fails
        // `/gnomon/api/session` on those sessions. Name that, rather than the
        // stack: the owner can act on "one conversation cannot be read".
        return { hits: [], unavailable: /descriptor version/.test(message) ? 'A conversation log this dsh cannot read is blocking the index.' : `The conversation index did not answer: ${message}` }
      }
    }
  }

  const cut = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text)

  api('/gnomon/api/search', async (_req, res, url) => {
    const query = (url.searchParams.get('q') ?? '').trim()
    if (query === '') {
      sendJson(res, 400, { unavailable: 'A search needs something to look for.' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let gone = false
    res.on('close', () => {
      gone = true
    })
    const emit = (frame) => {
      if (gone || res.writableEnded) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // The owner closed the card or searched again. Nothing to do.
      }
    }

    // Both corpora at once: neither waits on the other, and a failure in one
    // still shows the other rather than emptying the card.
    const [record, talk] = await Promise.all([
      executeGnomonTool('gnomon_semantic_search', { query, limit: SEARCH_RECORD_LIMIT })
        .then((hits) => (Array.isArray(hits) ? hits : []))
        .catch((error) => {
          console.error(`[${PLUGIN}] record search failed: ${error instanceof Error ? error.message : String(error)}`)
          return []
        }),
      searchConversations(query),
    ])
    const conversations = talk.hits
    emit({ type: 'hits', record, conversations, ...(talk.unavailable ? { conversationsUnavailable: talk.unavailable } : {}) })

    if (record.length === 0 && conversations.length === 0) {
      // Nothing to read. The empty list already says so, and a model asked to
      // summarise nothing writes an apology, which is worse than silence.
      emit({ type: 'done' })
      res.end()
      return
    }
    if (gone) return void res.end()

    const lines = [
      // The instant is carried explicitly now that `label` is the hit's own
      // words rather than a type/timestamp/process line.
      ...record.map((hit) => `- [${hit.refType}] ${hit.at ?? ''} ${hit.label ?? ''} — ${cut(String(hit.text ?? ''), SEARCH_LINE_CHARS)}`),
      ...conversations.map((hit) => `- [conversation] ${hit.at ?? ''} ${hit.role} — ${cut(hit.excerpt, SEARCH_LINE_CHARS)}`),
    ]

    // The owner closing the card also aborts the call: a reading nobody will
    // read is not worth finishing, and the provider is billed by the token.
    const stopReading = new AbortController()
    const tooLong = setTimeout(() => stopReading.abort(new Error('the model took too long')), SEARCH_READING_TIMEOUT_MS)
    res.on('close', () => stopReading.abort(new Error('the card was closed')))
    // Outside the try: an abort throws, and whatever the model had already
    // streamed is still the best answer available.
    let text = ''
    try {
      for await (const chunk of ctx.llm.stream({
        ...selection(),
        signal: stopReading.signal,
        messages: [
          createSystemMessage(
            [
              "You are Gnomon, reading back what a search of the owner's own record just returned. Address the owner as 'you'.",
              'Answer their search in at most three sentences: what the results show about it, and the one thing worth noticing. Name the specific projects, people, tools and days that appear in the results.',
              'Every result you were given is listed on screen directly beneath your answer, so never enumerate them and never repeat a line verbatim — say what they add up to.',
              'These results are ALL you have. Do not add anything you were not given, do not guess at what is missing, and do not offer to search again.',
              'Results tagged [conversation] are things said in chat; every other tag is observed activity. Keep the difference when it matters.',
              'If the results do not actually answer the search, say so plainly in one sentence instead of forcing a summary. Plain prose, no markdown, no headings, no lists.',
            ].join(' '),
          ),
          createUserMessage({ content: [{ type: 'text', text: `Search: ${query}\n\nResults:\n${lines.join('\n')}` }], source: { kind: 'user' } }),
        ],
      })) {
        if (gone) break
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'the model call failed')
        }
      }
      // Cut short with words already streamed: that partial sentence IS the
      // reading, and showing it beats replacing it with a timeout notice.
      emit(text.trim() === '' ? { type: 'reading', unavailable: 'The model returned nothing.' } : { type: 'reading', text: text.trim() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${PLUGIN}] search reading failed: ${message}`)
      // The hits are already on screen and are the durable half of the answer;
      // a failed reading says so in its own seat rather than replacing them.
      // A reading that got most of the way there is still worth reading, so it
      // ships with the cut marked rather than being thrown away for a notice.
      emit(text.trim() === '' ? { type: 'reading', unavailable: `Gnomon could not read these: ${message}` } : { type: 'reading', text: `${text.trim()} …[cut short: ${message}]` })
    } finally {
      clearTimeout(tooLong)
    }
    emit({ type: 'done' })
    res.end()
  })

  /**
   * The board: read it, or append one change to it.
   *
   * A POST is one `board:*` event — the owner's drop, resize, group, note —
   * through the kernel like every other change to the space, so the owner's
   * hands and Gnomon's tool write the same log and every open browser hears
   * the same `gnomon/board`.
   */
  const BOARD_EVENTS = new Set(['place', 'move', 'remove', 'focus', 'notice', 'walk', 'step', 'continue', 'plan', 'span', 'clear', 'arrange', 'save', 'load', 'section', 'unsection'])
  api('/gnomon/api/board', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 200, ctx.gnomonKernel.getState()?.board ?? { cards: {}, groups: {}, scenes: {}, focus: null, updatedAt: null })
      return
    }
    const body = await readBody(req, 65_536)
    const action = typeof body?.action === 'string' ? body.action : ''
    if (!BOARD_EVENTS.has(action)) {
      sendJson(res, 400, { unavailable: 'A board change needs an action.' })
      return
    }
    const { action: _a, ...payload } = body
    payload.by = 'owner'
    await ctx.gnomonKernel.appendSignal(`board:${action}`, payload)
    const board = ctx.gnomonKernel.getState()?.board ?? null
    ctx.emit('gnomon/board', board)
    sendJson(res, 200, board)
  })

  /**
   * The first-run back-fill (/setup). GET: the folders worth offering and the
   * last run. POST `{roots, gitDays, calendarDays, dryRun}`: a count when
   * `dryRun`, otherwise the run itself. One run at a time: a second POST while
   * one writes gets 409, never a second copy of the same history.
   */
  /**
   * Model providers (/setup). Read from the saved files, not from what this
   * process booted with, so the page can say "saved — restart to use it".
   * API keys are written, never read back: a GET says only whether one is set.
   *
   * POST `{op}`:
   *   check   `{baseUrl, apiKey?, target?}` → the models the endpoint lists
   *   save    `{target: 'default' | 'new' | <id>, label?, baseUrl, model, apiKey?}` (empty apiKey keeps the saved one)
   *   remove  `{target}`
   *   restart → the LaunchAgent restarts Sundial; without one, the command to run
   */
  const envPath = join(home, '.env')
  const configPath = join(home, 'config.json')
  const readEnvFile = async () => {
    const out = {}
    const text = await readFile(envPath, 'utf8').catch(() => '')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return out
  }
  const readConfigFile = async () => {
    try {
      return JSON.parse(await readFile(configPath, 'utf8'))
    } catch {
      return {}
    }
  }
  const savedProviders = async () => {
    const [env, config] = await Promise.all([readEnvFile(), readConfigFile()])
    const row = (id, baseUrl, model, label) => ({ id, label: label ?? providerLabel(baseUrl), baseUrl, model, hasKey: (env[providerKeyEnv(id)] ?? '') !== '', local: isLocalUrl(baseUrl) })
    const base = env.SUNDIAL_LLM_BASE_URL ?? ''
    return {
      default: base !== '' ? row('openai', base.replace(/\/+$/, ''), env.SUNDIAL_LLM_MODEL ?? '') : null,
      providers: parseProviders(config?.llm?.providers).map((p) => row(p.id, p.baseUrl, p.model, p.label)),
    }
  }
  const fingerprint = (saved) => JSON.stringify(saved)
  // What this process booted with; a saved change differs from it until a restart.
  const booted = savedProviders().then(fingerprint)
  const LABEL = process.env.SUNDIAL_LABEL || 'dev.sundial.agent'

  api('/gnomon/api/providers', async (req, res) => {
    if (req.method !== 'POST') {
      const saved = await savedProviders()
      sendJson(res, 200, { ...saved, restartNeeded: fingerprint(saved) !== (await booted) })
      return
    }
    const body = (await readBody(req, 8192)) ?? {}
    const text = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const baseUrl = text(body.baseUrl).replace(/\/+$/, '')
    const target = text(body.target, 40)

    if (body.op === 'check') {
      if (!isHttpUrl(baseUrl)) return sendJson(res, 200, { ok: false, error: 'That is not an http(s) address.' })
      const key = text(body.apiKey, 400) || (await readEnvFile())[providerKeyEnv(target === 'default' || target === '' ? 'openai' : target)] || 'gnomon-local'
      try {
        const answer = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
        if (answer.status === 401 || answer.status === 403) return sendJson(res, 200, { ok: false, error: 'The provider refused the key.' })
        if (!answer.ok) return sendJson(res, 200, { ok: false, error: `The provider answered ${answer.status}.` })
        const data = await answer.json().catch(() => null)
        const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter((id) => typeof id === 'string').sort().slice(0, 500) : []
        return sendJson(res, 200, { ok: true, label: providerLabel(baseUrl), local: isLocalUrl(baseUrl), models })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: error?.name === 'TimeoutError' ? 'No answer within 8 seconds.' : 'Nothing answered at that address.' })
      }
    }

    if (body.op === 'save') {
      const model = text(body.model, 200)
      const apiKey = text(body.apiKey, 400)
      if (!isHttpUrl(baseUrl) || model === '' || /[\s]/.test(model) || /[\s]/.test(apiKey)) return sendJson(res, 400, { unavailable: 'A provider needs an http(s) address and a model name, with no spaces.' })
      if (target === 'default') {
        setEnvValues(envPath, { SUNDIAL_LLM_BASE_URL: baseUrl, SUNDIAL_LLM_MODEL: model, ...(apiKey ? { SUNDIAL_LLM_API_KEY: apiKey } : {}) })
      } else {
        const config = await readConfigFile()
        const list = parseProviders(config?.llm?.providers)
        const label = text(body.label, 60) || providerLabel(baseUrl)
        let id = target
        if (target === 'new') {
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider'
          const stem = /^[a-z]/.test(slug) && slug.length > 1 && slug !== 'openai' && slug !== 'tensorx' ? slug : `p-${slug}`
          id = stem
          for (let n = 2; list.some((p) => p.id === id); n++) id = `${stem}-${n}`
          list.push({ id, label, baseUrl, model })
        } else {
          const at = list.findIndex((p) => p.id === target)
          if (at < 0) return sendJson(res, 404, { unavailable: 'No provider by that name.' })
          list[at] = { id, label, baseUrl, model }
        }
        await writeFile(configPath, `${JSON.stringify({ ...config, llm: { ...(config.llm ?? {}), providers: list } }, null, 2)}\n`, { mode: 0o600 })
        if (apiKey) setEnvValues(envPath, { [providerKeyEnv(id)]: apiKey })
      }
      const saved = await savedProviders()
      return sendJson(res, 200, { ...saved, restartNeeded: fingerprint(saved) !== (await booted) })
    }

    if (body.op === 'remove') {
      if (target === 'default') {
        setEnvValues(envPath, { SUNDIAL_LLM_BASE_URL: '', SUNDIAL_LLM_MODEL: '', SUNDIAL_LLM_API_KEY: '' })
      } else {
        const config = await readConfigFile()
        const list = parseProviders(config?.llm?.providers).filter((p) => p.id !== target)
        await writeFile(configPath, `${JSON.stringify({ ...config, llm: { ...(config.llm ?? {}), providers: list } }, null, 2)}\n`, { mode: 0o600 })
        setEnvValues(envPath, { [providerKeyEnv(target)]: '' })
      }
      const saved = await savedProviders()
      return sendJson(res, 200, { ...saved, restartNeeded: fingerprint(saved) !== (await booted) })
    }

    if (body.op === 'restart') {
      // Under Sundial.app the app restarts this process when it exits.
      if (process.env.SUNDIAL_APP === '1') {
        sendJson(res, 200, { restarted: true })
        setTimeout(() => process.exit(0), 300)
        return
      }
      const uid = process.getuid?.() ?? 0
      const loaded = await execFileP('launchctl', ['print', `gui/${uid}/${LABEL}`]).then(() => true, () => false)
      if (!loaded) return sendJson(res, 200, { restarted: false, command: 'sundial restart' })
      sendJson(res, 200, { restarted: true })
      // After the answer has left: this process is the one being restarted.
      setTimeout(() => spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { detached: true, stdio: 'ignore' }).unref(), 300)
      return
    }

    sendJson(res, 400, { unavailable: 'Unknown operation.' })
  })

  /**
   * Services (the Settings card): every switch in config.json, its value, and
   * its last signal. POST `{id, value}` writes that one key and nothing else;
   * the change waits for a restart (`/gnomon/api/providers` `{op: 'restart'}`),
   * like a model change does.
   */
  const bootedConfig = readConfigFile()
  api('/gnomon/api/services', async (req, res) => {
    if (req.method === 'POST') {
      const body = (await readBody(req, 1024)) ?? {}
      const service = SERVICES.find((s) => s.id === body.id)
      if (!allowed(service, body.value)) return sendJson(res, 400, { unavailable: 'That service has no such switch.' })
      const next = setPath(await readConfigFile(), service.path, body.value)
      const tmp = `${configPath}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, configPath)
      console.log(`[${PLUGIN}] services: ${service.path} = ${JSON.stringify(body.value)} (restart to apply)`)
    }
    const [config, booted, freshness] = await Promise.all([readConfigFile(), bootedConfig, getSignalFreshness().catch(() => [])])
    const services = describe(config, booted, freshness)
    sendJson(res, 200, { services, restartNeeded: services.some((s) => s.changed) })
  })

  let backfilling = false
  api('/gnomon/api/backfill', async (req, res) => {
    const backfill = ctx.gnomonKernel.backfill
    if (req.method !== 'POST') {
      const [roots, last] = await Promise.all([backfill.defaults(), backfill.last()])
      sendJson(res, 200, { roots, gitDays: 30, calendarDays: 7, mailDays: 7, last, running: backfilling })
      return
    }
    const body = await readBody(req, 8192)
    const roots = Array.isArray(body?.roots) ? body.roots.filter((r) => typeof r === 'string' && r.trim() !== '').slice(0, 20) : []
    const opts = { roots, gitDays: Number(body?.gitDays ?? 30), calendarDays: Number(body?.calendarDays ?? 7), mailDays: Number(body?.mailDays ?? 0) }
    if (body?.dryRun === true) {
      sendJson(res, 200, await backfill.plan(opts))
      return
    }
    if (backfilling) {
      sendJson(res, 409, { unavailable: 'A back-fill is already running.' })
      return
    }
    backfilling = true
    try {
      sendJson(res, 200, await backfill.run(opts))
    } finally {
      backfilling = false
    }
  })

  /**
   * The owner's settings: read them, or change any subset.
   *
   * A POST is one `settings:set` event through the kernel, like every other
   * change — so the rules see it on the same tick, the model's tools are
   * refused by it, and every open tab hears it on the live channel.
   */
  api('/gnomon/api/settings', async (req, res) => {
    const read = () => ctx.gnomonKernel.getState()?.settings ?? null
    if (req.method !== 'POST') {
      sendJson(res, 200, read())
      return
    }
    const body = await readBody(req, 4096)
    if (body === null || typeof body !== 'object') {
      sendJson(res, 400, { unavailable: 'The settings could not be read.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('settings:set', { ...body, by: 'owner' })
    const settings = read()
    ctx.emit('gnomon/settings', settings)
    sendJson(res, 200, settings)
  })

  /**
   * How much this session may do without stopping to ask.
   *
   * dsh's permission preset already IS this control — `gnomon-actions` derives
   * every one of its own verdicts from the same preset, so one switch governs
   * dsh's built-ins and Gnomon's tools together. What was missing was a way to
   * reach it: the preset lives behind a `/permission` slash command in a client
   * that does not boot here, so every session ran on whatever it was pinned
   * with and `gnomon_run_shell` asked forever.
   *
   * Auto is NOT unguarded. The destructive-command refusal in
   * `plugins/sundial-actions/destructive.js` runs regardless of preset — rm -rf,
   * sudo, dd, a curl piped into a shell, a force push — so the thing Auto turns
   * off is the prompt, not the backstop.
   *
   * A GET never wakes a sleeping session just to read a label: an agent that is
   * not live yet has no preset of its own, and the deployment default is the
   * honest answer for it.
   */
  api('/gnomon/api/permission', async (req, res, url) => {
    const presets = ctx.get?.('permissionPresets')
    if (presets === undefined) {
      sendJson(res, 200, { current: null, names: [], available: false })
      return
    }
    const names = [...presets.names]
    if (req.method !== 'POST') {
      const sessionId = url.searchParams.get('session') ?? ''
      let current = presets.defaultPreset
      const live = sessionId === '' ? undefined : ctx.agents.get(SessionId(sessionId))
      if (live !== undefined && live.status !== 'disposed') current = presets.current(live.session)
      sendJson(res, 200, { current, names, available: true, live: live !== undefined })
      return
    }
    const body = await readBody(req, 1024)
    const preset = typeof body?.preset === 'string' ? body.preset : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!names.includes(preset) || sessionId === '') {
      sendJson(res, 400, { unavailable: 'A permission change needs a session and a known preset.' })
      return
    }
    // Resume rather than read: the switch has to land on the session the owner
    // is looking at, and a preset set on nothing is a switch that does nothing.
    const agent = await agentFor(sessionId)
    presets.set(agent.session, preset)
    const current = presets.current(agent.session)
    console.log(`[${PLUGIN}] session ${sessionId} is now ${current}`)
    sendJson(res, 200, { current, names, available: true, live: true })
  })

  /**
   * Ambient hearing, by hand: read the window, or open and close it.
   *
   * The window is normally the `hearingWindow` rule's own reading of the
   * calendar and the microphone. This is the owner overriding that reading —
   * the huddle nobody scheduled, or the hour they would rather not have heard.
   * One `hearing:set` event, folded by the same rule, so the override replays
   * and the sidecar picks it up on the next poll like any other decision.
   */
  api('/gnomon/api/hearing', async (req, res) => {
    const read = () => ctx.gnomonKernel.getState()?.hearing ?? null
    if (req.method !== 'POST') {
      sendJson(res, 200, read())
      return
    }
    const body = await readBody(req, 1024)
    if (body === null || typeof body !== 'object' || typeof body.listen !== 'boolean') {
      sendJson(res, 400, { unavailable: 'Say listen: true or listen: false.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('hearing:set', {
      listen: body.listen,
      ...(typeof body.minutes === 'number' ? { minutes: body.minutes } : {}),
      by: 'owner',
    })
    // The strip reads hearing off the `now` frame, so every open tab should see
    // the chip flip now rather than at the next 30-second pulse.
    broadcast({ type: 'now', now: snapshot() })
    sendJson(res, 200, read())
  })

  /**
   * A spoken message, typed out by the machine's own ears.
   *
   * The audio goes to the whisper server the hearing sensor already runs on
   * loopback — never to a browser speech service, which would send the owner's
   * voice off the machine for a convenience. Body in, text out; nothing is kept.
   */
  const WHISPER = 'http://127.0.0.1:8771/inference'
  api('/gnomon/api/transcribe', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Speech takes a POST.' })
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8_000_000) {
        sendJson(res, 413, { unavailable: 'That recording is too long.' })
        return
      }
      chunks.push(chunk)
    }
    try {
      // The browser records webm/opus; whisper wants PCM WAV. ffmpeg is already
      // on this machine for the hearing sensor, so the conversion is a pipe
      // rather than a dependency — and a failure here is a clear message, not
      // a mystery empty transcript.
      let audio = Buffer.concat(chunks)
      const isWav = audio.subarray(0, 4).toString() === 'RIFF'
      if (!isWav) {
        audio = await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-ac', '1', '-ar', '16000', 'pipe:1'])
          const out = []
          const err = []
          ff.stdout.on('data', (d) => out.push(d))
          ff.stderr.on('data', (d) => err.push(d))
          ff.on('error', reject)
          ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().slice(0, 200) || `ffmpeg exited ${code}`))))
          ff.stdin.on('error', () => {})
          ff.stdin.end(audio)
        })
      }
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
      form.append('response_format', 'json')
      const got = await fetch(WHISPER, { method: 'POST', body: form })
      if (!got.ok) {
        sendJson(res, 502, { unavailable: `The local transcriber answered ${got.status}.` })
        return
      }
      const body = await got.json()
      sendJson(res, 200, { text: String(body?.text ?? '').trim() })
    } catch (error) {
      // Not running is the ordinary case, not a fault: the hearing sensor owns
      // that process, and the owner may have it off.
      sendJson(res, 503, { unavailable: `The local transcriber is not answering on 8771. ${error instanceof Error ? error.message : ''}`.trim() })
    }
  })

  api('/gnomon/api/session', async (req, res, url) => {
    const id = url.searchParams.get('id') ?? ''
    if (id === '') {
      sendJson(res, 400, { unavailable: 'Which session?' })
      return
    }
    let snapshot
    try {
      snapshot = await readSnapshot(id)
    } catch (error) {
      // A fresh install has no companion conversation yet: that is empty, not broken.
      if (/not found/i.test(error instanceof Error ? error.message : '')) {
        sendJson(res, 200, { id, title: '', frames: [], model: selection().model ?? null })
        return
      }
      throw error
    }
    sendJson(res, 200, {
      id,
      title: titleFrom(snapshot.events, ''),
      frames: replayFrames(snapshot.events),
      model: selection().model ?? null,
    })
  })

  /**
   * Hand over one file Gnomon presented.
   *
   * THE SESSION LOG IS THE ALLOWLIST, and that is the whole security design.
   * This route serves a path only when that exact string appears in a
   * `deliverables/presented` event in the named session — an event dsh appends
   * only after its `present` tool resolved the path through the sandboxed
   * `ctx.fs` and confirmed an existing regular file. So a servable path was
   * chosen by the model, checked by dsh's sandbox, and recorded durably,
   * before this route will look at it.
   *
   * There is deliberately no path handling here: no joining, no normalizing,
   * no `..` stripping, no root prefix check. Every one of those is a way to be
   * clever about an attacker-supplied string, and none is needed — an exact
   * match against a recorded delivery cannot be talked into a traversal. If
   * the string is not in the log, the answer is 404 and nothing is read.
   *
   * The bytes are read at request time, never at present time: dsh's contract
   * is that the owner opens the CURRENT file, so what they get is what is
   * there when they click, and a file since deleted is an honest 404.
   */
  api('/gnomon/api/deliverable', async (req, res, url) => {
    const id = url.searchParams.get('session') ?? ''
    const wanted = url.searchParams.get('path') ?? ''
    if (id === '' || wanted === '') {
      sendJson(res, 400, { unavailable: 'Which file, from which session?' })
      return
    }

    const snapshot = await readSnapshot(id)
    const presented = new Set()
    for (const event of snapshot.events ?? []) {
      if (event?.type !== 'deliverables/presented') continue
      for (const file of event.data?.files ?? []) {
        if (typeof file?.path === 'string') presented.add(file.path)
      }
    }
    if (!presented.has(wanted)) {
      sendJson(res, 404, { unavailable: 'Gnomon did not hand you that file.' })
      return
    }

    let info = null
    try {
      info = await stat(wanted)
    } catch {
      info = null
    }
    if (info === null || !info.isFile()) {
      sendJson(res, 404, { unavailable: 'That file is no longer there. Gnomon points at the file where it sits; it never kept a copy.' })
      return
    }
    if (info.size > MAX_DELIVERABLE_BYTES) {
      sendJson(res, 413, { unavailable: `That file is ${Math.round(info.size / 1_000_000)}MB — too large to hand over through the browser. Open it from ${wanted}.` })
      return
    }

    // `attachment` so a browser saves it rather than trying to render it, and
    // a quoted basename so a name with a space or a comma survives the header.
    const name = basename(wanted).replace(/["\\]/g, '') || 'deliverable'
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    })
    res.end(await readFile(wanted))
  })

  /**
   * Start a session.
   *
   * The id is minted here rather than by the client so that two tabs pressing
   * "new" cannot collide on one, and so the client never has to know dsh's id
   * shape.
   */
  api('/gnomon/api/session/new', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Starting a session takes a POST.' })
      return
    }
    const id = `session-${randomUUID()}`
    await agentFor(id, { create: true })
    console.log(`[${PLUGIN}] session ${id} created`)
    sendJson(res, 200, { id })
  })

  /**
   * Say something, and stream the turn it opens.
   *
   * One request, not a POST plus a separate stream to subscribe on: there is
   * then no window in which the turn has started and nobody is listening.
   * Closing the tab aborts the request, which unwatches the stream and never
   * cancels the turn — an answer the owner walked away from still lands in the
   * log, and the tokens are already spent either way.
   */
  /**
   * Compact this conversation now, rather than waiting for the threshold.
   *
   * `command-compact` is enabled in the profile (dsh-base mounts it,
   * dsh-web-app disabled it, the machine's patch re-enables it) and
   * `compaction-basic` already compacts automatically at 80% of the model's
   * declared window. This is the manual lever for the pinned conversation,
   * where the owner can see the gauge and decide the transcript has served its
   * purpose.
   *
   * Through `commands.execute`, which parses the slash line and resolves the
   * command FOR THAT AGENT — not by sending "/compact" down the turn route,
   * where it would reach the model as the literal text of a message. A name
   * that does not resolve returns undefined rather than throwing, so a profile
   * without the command answers honestly instead of pretending.
   */
  /**
   * One image in, a durable reference out.
   *
   * `attachment-local` is enabled and was unused: it content-addresses the
   * bytes under `DSH_HOME/attachments/v1` and validates media type, byte size
   * and pixel count against its own limits (png/jpeg/webp/gif, 20 per message).
   * The ref it returns is what an `ImageBlock` carries, which is why a
   * transcript does not end up holding base64 for the life of the session —
   * the adapter reads the bytes back per request instead.
   *
   * The client posts raw bytes with the real content-type rather than a JSON
   * data URI: base64 in a JSON body is a third larger and buys nothing here.
   */
  api('/gnomon/api/attach', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Attaching takes a POST.' })
      return
    }
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      sendJson(res, 501, { unavailable: 'This profile stores no attachments.' })
      return
    }

    const chunks = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
          sendJson(res, 413, { unavailable: 'That image is too large.' })
          return
        }
        chunks.push(chunk)
      }
    } catch {
      sendJson(res, 400, { unavailable: 'The image could not be read.' })
      return
    }

    try {
      // The store validates media type, dimensions and byte count itself, and
      // throws with its own reason — which is worth passing on verbatim, since
      // "not a PNG" and "too many pixels" need different fixes from the owner.
      const ref = await attachments.saveImage({
        data: new Uint8Array(Buffer.concat(chunks)),
        mediaType: String(req.headers['content-type'] ?? '').split(';')[0].trim(),
        ...(typeof req.headers['x-gnomon-filename'] === 'string' ? { name: req.headers['x-gnomon-filename'].slice(0, 120) } : {}),
      })
      sendJson(res, 200, { attachment: ref })
    } catch (error) {
      sendJson(res, 400, { unavailable: error instanceof Error ? error.message : 'That image was refused.' })
    }
  })

  api('/gnomon/api/compact', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Compacting takes a POST.' })
      return
    }
    const body = await readBody(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') {
      sendJson(res, 400, { unavailable: 'Compacting needs a session.' })
      return
    }
    // Resolved at call time, like every other optional dsh service here.
    const commands = ctx.get?.('commands')
    if (commands === undefined || typeof commands.execute !== 'function') {
      sendJson(res, 501, { unavailable: 'This profile has no commands service.' })
      return
    }
    const agent = await agentFor(sessionId)
    if (agent === null || agent === undefined || agent.status === 'disposed') {
      sendJson(res, 409, { unavailable: 'That session is no longer running.' })
      return
    }
    const settled = await commands.execute(agent, '/compact', AbortSignal.timeout(COMPACT_TIMEOUT_MS))
    if (settled === undefined) {
      sendJson(res, 501, { unavailable: 'The /compact command is not available on this profile.' })
      return
    }
    sendJson(res, 200, { compacted: true })
  })

  const REPLY_RULES = [
    'How to reply: answer the question in your first sentence, then stop. Match the length asked; with none, one to three sentences.',
    'Only what was asked — at most one unasked point, and only if it matters today.',
    'Never end with an offer ("Want me to…", "Say the word…", "I can also…").',
    'If they only acknowledge ("ok", "thanks", "nice"), reply with a few words and nothing else. A choice only they can make is an ask_user_question, not a question in prose.',
    'Use as few tools as answer it; the shell only when no gnomon_* tool can.',
  ].join(' ')

  /**
   * Watch a session: every frame of every turn in it, as it happens.
   *
   * The POST below streams only the turn the owner opened. A turn nobody typed
   * — the companion woken by a notice, a job reporting back, a turn that went
   * quiet on the POST and carried on — used to appear only after the session
   * was reopened. The browser keeps one of these open for the session it shows;
   * it is silent while that session's own POST is streaming, so nothing draws
   * twice. A `turn` frame opens each new run of frames so it lands in its own block.
   */
  /**
   * Bring a side thread into the conversation. Its words (the latest part, if
   * long) ride into the companion as context, and the companion says in a line
   * or two what that thread settled — a turn the session watch streams live.
   */
  api('/gnomon/api/bring', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Bringing a thread in takes a POST.' })
      return
    }
    const body = await readBody(req)
    const from = typeof body?.from === 'string' ? body.from.trim() : ''
    if (from === '' || from === COMPANION_SESSION_ID) {
      sendJson(res, 400, { unavailable: 'Which thread? (The conversation cannot be brought into itself.)' })
      return
    }
    const snapshot = await readSnapshot(from)
    // A thread too new for the log to name falls back to the name the owner saw on it.
    const title = (titleFrom(snapshot.events, '') || (typeof body.title === 'string' ? body.title.trim() : '') || 'a side thread').slice(0, 120)
    const lines = replayFrames(snapshot.events)
      .filter((f) => f.type === 'user' || f.type === 'say')
      .map((f) => `${f.type === 'user' ? 'Owner' : 'Gnomon'}: ${f.text.trim()}`)
    if (lines.length === 0) {
      sendJson(res, 409, { unavailable: 'That thread has nothing in it to bring.' })
      return
    }
    const joined = lines.join('\n\n')
    const digest = joined.length > BRING_CHARS ? `…${joined.slice(-BRING_CHARS)}` : joined
    const agent = await agentFor(COMPANION_SESSION_ID)
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: `The owner brought another thread into this conversation: "${title}". Its words, oldest first${digest === joined ? '' : ' (only the latest part)'}:\n\n${digest}` }],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: `Brought in: ${title}` },
      }),
    )
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'In one or two sentences, say what that thread settled and what is still open, so the owner can carry on from here. No offer.' }],
        source: { kind: 'plugin', plugin: PLUGIN },
      }),
    )
    sendJson(res, 200, { brought: true, title })
  })

  /** The owner's answer to the open `ask_user_question` in a session. */
  api('/gnomon/api/question', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Answering takes a POST.' })
      return
    }
    const body = await readBody(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const settle = openQuestions.get(sessionId)
    if (settle === undefined) {
      sendJson(res, 404, { unavailable: 'That question is no longer waiting.' })
      return
    }
    const answers = (Array.isArray(body.answers) ? body.answers : [])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({ id: a.id, selected: (Array.isArray(a.selected) ? a.selected : []).filter((x) => typeof x === 'string'), ...(typeof a.custom === 'string' && a.custom.trim() !== '' ? { custom: a.custom.trim() } : {}) }))
    settle(answers)
    sendJson(res, 200, { answered: true })
  })

  /** Stop one running tool call; the turn goes on. */
  api('/gnomon/api/tool/stop', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Stopping takes a POST.' })
      return
    }
    const body = await readBody(req)
    const callId = typeof body?.callId === 'string' ? body.callId : ''
    const controller = stoppers.get(callId)
    if (controller === undefined) {
      sendJson(res, 404, { unavailable: 'That call is no longer running.' })
      return
    }
    controller.abort('owner')
    sendJson(res, 200, { stopped: true })
  })

  api('/gnomon/api/watch', async (req, res, url) => {
    const id = url.searchParams.get('id') ?? ''
    if (id === '') {
      sendJson(res, 400, { unavailable: 'Which session?' })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const write = (frame) => {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone mid-frame: the close handler below cleans up.
      }
    }
    // Whatever this thread is still waiting on, asked again for the browser
    // that just opened it: an approval, or that its open question is live.
    for (const { sessionId, frame } of waiting.values()) if (sessionId === id) write(frame)
    if (openQuestions.has(id)) write({ type: 'question-open' })
    let between = true
    const off = watch(id, (frame) => {
      if (turning.has(id) || res.writableEnded) return
      if (between && frame.type !== 'done') write({ type: 'turn', by: 'gnomon' })
      between = frame.type === 'done'
      write(frame)
    })
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n')
      } catch {
        // Closed; see below.
      }
    }, 25_000)
    req.on('close', () => {
      off()
      clearInterval(beat)
    })
  })

  api('/gnomon/api/turn', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A turn takes a POST.' })
      return
    }
    const body = await readBody(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (sessionId === '' || text === '') {
      sendJson(res, 400, { unavailable: 'A turn needs a session and something to say.' })
      return
    }

    const agent = await agentFor(sessionId)
    if (agent === null || agent === undefined || agent.status === 'disposed') {
      sendJson(res, 409, { unavailable: 'That session is no longer running.' })
      return
    }
    // This turn is about to put words in that log, so whatever the thread list
    // remembers it is called is now a guess. The next listing reads it again.
    forgetTitle(sessionId)

    // WHERE the owner was standing when they said it. This is the one thing a
    // client can tell a model that the model cannot find out for itself: "why?"
    // asked over the Shape instrument is a different question from "why?" asked
    // over Today, and it cannot see the screen.
    //
    // Injected as CONTEXT rather than folded into the message, so the owner's
    // own words stay theirs in the transcript.
    // And WHAT they are doing, off the kernel. This is the line that makes the
    // difference between an assistant and a search box: "am I doing okay?" is
    // answerable without a tool call, because the answer was already in hand.
    const place = typeof body.place === 'string' ? body.place.trim().slice(0, 200) : ''
    // The owner is answering Gnomon's own question. The client has already
    // recorded the answer; this tells the model WHAT was asked, so the reply
    // is read as the answer it is and not as a new topic.
    const answering = typeof body.answering?.question === 'string' ? body.answering.question.trim().slice(0, 400) : ''
    // Refs the client got back from /gnomon/api/attach. Shape-checked rather
    // than trusted: a malformed ref would reach the adapter's byte read.
    const images = Array.isArray(body.images)
      ? body.images
          .filter((ref) => ref !== null && typeof ref === 'object' && typeof ref.attachmentId === 'string' && typeof ref.mediaType === 'string')
          .slice(0, MAX_IMAGES_PER_TURN)
      : []
    const present = nowLine(snapshot())
    agent.inject(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: [
              answering !== ''
                ? `The owner is ANSWERING a question Gnomon asked them: "${answering}". Their message is that answer. Keep what is worth keeping from it — decisions, who said what, follow-ups — with the tools you have (gnomon_assert with saidBy: 'owner' for facts — these are their own words), and reply briefly with what you kept. Do not ask the question again.`
                : null,
              place !== '' ? `The owner is looking at: ${place}.` : null,
              present,
              'A question like "what changed?", "why?" or "is that bad?" is about what is on that screen and what they are doing right now — resolve it there first, before reaching for anything broader. Do not recite this context back; use it.',
              // Last in the context the model reads before the owner's words,
              // because that is where it listens: benched 2026-09-23, the same
              // rules in the persona alone left "ok" answered with 125 words and
              // most replies closing on "Say the word…".
              REPLY_RULES,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(place !== '' ? `Looking at ${place}` : present) },
      }),
    )

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // No proxy sits in front of this today, but a Tailscale Serve route would
      // buffer the whole stream into one lump.
      'x-accel-buffering': 'no',
    })

    await new Promise((resolve) => {
      let settled = false
      let timer = null

      // A turn that ends having produced NOTHING — no text, no tool call — is
      // not a turn that chose silence. dsh closes a turn whose step it could
      // not build (a model id the route does not serve, for one) with
      // `turn/end: complete` and zero steps, logs nothing, and the ledger never
      // sees a call. Seen live: an owner asked "what time is it?" and got an
      // empty turn that looked exactly like Gnomon declining to answer. Say so.
      let produced = false
      const emit = (frame) => {
        if (res.writableEnded) return
        if (frame.type === 'text' || frame.type === 'tool' || frame.type === 'surface') produced = true
        if (frame.type === 'done' && !produced) {
          const current = selection()
          // dsh's OWN reason, when it has one, beats the guess. A turn that
          // died on a plugin exception carries the message here
          // (`autonomy is not defined` did, for three days) and the guess
          // blamed the model instead, sending the owner to the model picker.
          const message =
            typeof frame.message === 'string' && frame.message !== ''
              ? `The turn ended before a single step ran: ${frame.message}`
              : `The model produced nothing — the turn ended before a single step ran. ${current.provider}/${current.model} refused the call or is not served by that route. Say it again, or pick another model in the rail's foot.`
          frame = { type: 'error', message }
          produced = true
          emitRaw(frame)
          emitRaw({ type: 'done', reason: 'empty' })
          finish()
          return
        }
        emitRaw(frame)
        // Any frame at all is progress, a long tool run included.
        arm()
        if (frame.type === 'done') finish()
      }
      const emitRaw = (frame) => {
        try {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        } catch {
          // A client that went away mid-frame is the normal case, not a fault.
        }
      }

      const unwatch = watch(sessionId, emit)
      turnOpened(sessionId)

      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        unwatch()
        turnClosed(sessionId)
        resolve()
      }
      function arm() {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          emit({ type: 'error', message: 'That turn went quiet. It may still be running — reopen the session to see.' })
          finish()
        }, TURN_IDLE_MS)
      }

      res.on('close', finish)
      // Images ride WITH the owner's words, in the same message: a picture
      // sent as its own turn is a turn with no question in it.
      agent.followup(createUserMessage({ content: [{ type: 'text', text }, ...images.map((attachment) => ({ type: 'image', attachment }))], source: { kind: 'user' } }))
      arm()
    })

    if (!res.writableEnded) res.end()
  })

  /**
   * The models this deployment can reach, and which one is current.
   *
   * Discovery is best-effort per provider: a route whose adapter cannot list
   * (a local server that is down, a key that expired) contributes nothing
   * rather than failing the whole picker, because the OTHER provider is still
   * usable and a picker that vanishes is worse than a short one.
   */
  api('/gnomon/api/models', async (_req, res, url) => {
    // `?session=` asks for THAT thread's model; without it, the default.
    const session = url.searchParams.get('session') ?? ''
    const current = (session !== '' ? threadModel(session) ?? (await rememberedModel(SessionId(session))) : null) ?? selection()
    const models = []
    // Route id → the adapter's display name, so the picker can say "TensorX"
    // and not only "tensorx". Two routes can reach the same host under
    // different names (a generic adapter and Gnomon's own), and the id is the
    // only thing that tells them apart, so both travel.
    const providers = {}
    for (const provider of ctx.llm?.listProviders?.() ?? []) {
      const id = provider?.provider ?? provider?.id ?? provider?.name
      // `tensorx` is the old name of the `openai` route, kept for old threads.
      if (typeof id !== 'string' || id === '' || id === 'tensorx') continue
      providers[id] = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id
      try {
        for (const model of await ctx.llm.listModels(id)) {
          const modelId = model?.model ?? model?.id
          if (typeof modelId !== 'string' || modelId === '') continue
          models.push({
            provider: id,
            providerName: providers[id],
            model: modelId,
            ...(typeof model?.description === 'string' && model.description !== '' ? { description: model.description } : {}),
          })
        }
      } catch {
        // This provider cannot be listed right now. Not fatal, and not worth
        // telling the owner about — it simply has nothing to offer today.
      }
    }
    // The current selection always appears, even when discovery missed it: a
    // picker that does not contain what is running is lying about the state.
    if (!models.some((m) => m.provider === current.provider && m.model === current.model)) {
      models.unshift({ provider: current.provider, providerName: providers[current.provider] ?? current.provider, model: current.model })
    }
    sendJson(res, 200, { current: { ...current, providerName: providers[current.provider] ?? current.provider }, scope: session !== '' ? 'thread' : 'default', models })
  })

  api('/gnomon/api/model', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Choosing a model takes a POST.' })
      return
    }
    const body = await readBody(req, 4096)
    const provider = typeof body?.provider === 'string' ? body.provider : ''
    const model = typeof body?.model === 'string' ? body.model : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (provider === '' || model === '') {
      sendJson(res, 400, { unavailable: 'A choice needs a provider and a model.' })
      return
    }
    // A thread named → that thread, from its next step on (J1.10); dsh appends
    // a notice to the conversation so the switch is on the record. No thread →
    // the default for agents created from here on, as before.
    if (sessionId !== '') {
      await agentFor(sessionId)
      const ref = threadModels.get(sessionId)
      ref.current = { ...ref.current, provider, model }
      console.log(`[${PLUGIN}] thread ${sessionId} now uses ${provider}/${model}`)
      sendJson(res, 200, { current: ref.current, scope: 'thread' })
      return
    }
    await ctx.agentDefaultModel.saveSelection({ ...selection(), provider, model })
    console.log(`[${PLUGIN}] default model is now ${provider}/${model}`)
    sendJson(res, 200, { current: selection(), scope: 'default' })
  })

  /** The live channel. Opens with the present and the open question, then follows. */
  api('/gnomon/api/live', async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const emit = (frame) => {
      if (res.writableEnded) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone. The close handler below takes it out of the set.
      }
    }
    live.add(emit)
    emit({ type: 'now', now: snapshot() })
    emit({ type: 'ask', open: openAsk() })
    // A tab that connects mid-session gets the settings in force, not the defaults.
    emit({ type: 'settings', settings: ctx.gnomonKernel.getState()?.settings ?? null })
    await new Promise((resolve) => res.on('close', resolve))
    live.delete(emit)
  })

  /** The owner's answer to an approval the stream asked for. */
  // The owner's verdict on something Gnomon produced — a notice, a fact, an
  // insight, a moment. `feedback:verdict` is an ordinary signal; `feedbackTrack`
  // folds it (a `wrong` on a fact RETRACTS it), so the verdict needs no model
  // in between and lands the same way whether it came from a block's act, an
  // Unsaid row, or a fact row. This route exists because the CLI that used to
  // carry it is dead and, until now, only "not now" on a notice had a live path.
  const VERDICTS = new Set(['useful', 'wrong', 'not-now'])
  const ARTIFACT_KINDS = new Set(['knowledge_entry', 'moment', 'entity_fact', 'ask_thread', 'notice', 'owner_ask'])
  // J5.3 — plan this week for an ACTIVE goal now, rather than on Monday.
  // One `goal:pursue` through the kernel; `goalPursuit` emits the plan effect.
  api('/gnomon/api/goal-pursue', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Pursuing a goal takes a POST.' })
      return
    }
    const body = await readBody(req, 1024)
    const goalId = typeof body?.goalId === 'string' ? body.goalId.trim() : ''
    if (goalId === '') {
      sendJson(res, 400, { unavailable: 'Say which goalId (goal:<slug>) to plan.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('goal:pursue', { goalId, by: 'owner' })
    sendJson(res, 200, { planning: goalId, pursuit: ctx.gnomonKernel.getState()?.goals?.pursuit?.[goalId] ?? null })
  })

  // J4.3 — the owner's tap on a draft: `sent` (they opened their mail client
  // from the card) or `dismissed`. Gnomon sends nothing; this records the tap.
  api('/gnomon/api/draft', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A draft verdict takes a POST.' })
      return
    }
    const body = await readBody(req, 2048)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    const outcome = body?.outcome === 'sent' || body?.outcome === 'dismissed' ? body.outcome : ''
    if (id === '' || outcome === '') {
      sendJson(res, 400, { unavailable: 'A draft verdict needs its id and outcome: sent or dismissed.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('draft:closed', { id, outcome, by: 'owner' })
    sendJson(res, 200, { closed: id, outcome })
  })

  // J2.1 — the owner's own word on how it is going: flow / meh / stuck. One
  // `owner:self-report` through the kernel; `ownerPerceive` scores its belief
  // against it (the Brier the gate waits for). Three a day is the surface's
  // rhythm, not the route's rule.
  api('/gnomon/api/self-report', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A self-report takes a POST.' })
      return
    }
    const body = await readBody(req, 1024)
    const tap = body?.tap
    if (tap !== 'flow' && tap !== 'meh' && tap !== 'stuck') {
      sendJson(res, 400, { unavailable: 'Say tap: flow, meh or stuck.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('owner:self-report', { tap, by: 'owner' })
    broadcast({ type: 'now', now: snapshot() })
    sendJson(res, 200, { recorded: tap })
  })

  // J4.4 — the owner closing a promise heard aloud (or any open thread): one
  // `commitment:closed` through the kernel; `commitmentTrack` files the close.
  api('/gnomon/api/commitment', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Closing a thread takes a POST.' })
      return
    }
    const body = await readBody(req, 4096)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (id === '' || body?.close !== true) {
      sendJson(res, 400, { unavailable: 'Closing a thread needs its id and close: true.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('commitment:closed', { id, by: 'owner' })
    sendJson(res, 200, { closed: id })
  })

  // A page in Gnomon's browser, live: every repaint as a frame on one stream,
  // for as long as its card is open. The card draws the newest frame; nothing
  // is stored.
  api('/gnomon/api/webview', async (req, res, url) => {
    const id = url.searchParams.get('page') ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const write = (frame) => {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone mid-frame: the close handler stops the stream.
      }
    }
    let stop = null
    req.on('close', () => stop?.())
    try {
      stop = await watchPage(id, write)
      if (req.destroyed) stop()
    } catch (error) {
      write({ type: 'gone', reason: error instanceof Error ? error.message : String(error) })
      res.end()
    }
  })

  // The owner's own click, key or scroll on that page. Never logged: a
  // password typed into the card goes to the page and nowhere else.
  api('/gnomon/api/webinput', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Input takes a POST.' })
      return
    }
    const body = await readBody(req, 65_536)
    try {
      await inputPage(String(body?.page ?? ''), body ?? {})
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 409, { unavailable: error instanceof Error ? error.message : String(error) })
    }
  })

  // What Gnomon has set itself to come back to (gnomon_schedule_wakeup), for the Work card.
  api('/gnomon/api/wakeups', async (_req, res) => {
    sendJson(res, 200, { open: ctx.gnomonKernel.getState()?.wakeups?.open ?? [] })
  })

  // W2 — ask for a world-hygiene pass now rather than at the next midnight.
  // The pass itself is deterministic and logs its plan; this only rings it.
  api('/gnomon/api/hygiene', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A hygiene pass is asked for with a POST.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('world:hygiene-requested', { by: 'operator' })
    sendJson(res, 200, { requested: true })
  })

  // J2.6 — the rejudge job: `POST { all?, limit?, bench? }` starts it, a GET
  // reads its progress. Loopback-only like every route; `apps/harness/bin/
  // gnomon-rejudge.js` is the hand that calls it.
  api('/gnomon/api/rejudge', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 200, ctx.gnomonKernel.rejudgeStatus())
      return
    }
    const body = (await readBody(req, 4096)) ?? {}
    const num = (v) => (Number.isInteger(v) && v > 0 ? v : undefined)
    sendJson(res, 200, ctx.gnomonKernel.rejudge({ all: body.all === true, limit: num(body.limit), bench: num(body.bench), pack: num(body.pack), sinceDays: num(body.sinceDays) }))
  })

  api('/gnomon/api/feedback', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A verdict takes a POST.' })
      return
    }
    const body = await readBody(req, 8192)
    const artifactKind = typeof body?.artifactKind === 'string' ? body.artifactKind : ''
    const artifactId = typeof body?.artifactId === 'string' ? body.artifactId.trim() : ''
    const verdict = typeof body?.verdict === 'string' ? body.verdict : ''
    const note = typeof body?.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 500) : undefined
    if (!ARTIFACT_KINDS.has(artifactKind) || artifactId === '' || !VERDICTS.has(verdict)) {
      sendJson(res, 400, { unavailable: 'A verdict needs artifactKind, artifactId and one of useful / wrong / not-now.' })
      return
    }
    await ctx.gnomonKernel.appendSignal('feedback:verdict', { artifactKind, artifactId, verdict, ...(note ? { note } : {}) })
    sendJson(res, 200, { recorded: true, artifactKind, artifactId, verdict })
  })

  // The owner's word, as a fact — the same door `gnomon_assert` opens from the
  // chat, for a caller with no model in between (a form, a migration, a
  // script). Enters as an `entity:fact-candidate` with `provenance:
  // 'assertion'`; the fold's shape gate (`rejectEntityName`) still decides, so
  // a 200 here means "offered", not "believed". Loopback-only like every route.
  const ASSERT_KINDS = new Set(['owner', 'person', 'project', 'tool', 'topic', 'goal'])
  /**
   * The owner accepting the cleaned-up copy of a speech capture.
   *
   * One signal, one meaning. Not a `feedback:verdict` on the moment: a verdict
   * there says the MOMENT was useful, and two meanings on one row is a record
   * nobody can read back in a month. Nothing is deleted — the raw capture stays
   * where it is, and this only changes which copy the page shows first.
   */
  api('/gnomon/api/transcript-accept', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Accepting a transcript takes a POST.' })
      return
    }
    const body = await readBody(req, 4096)
    const momentId = typeof body?.momentId === 'string' ? body.momentId.trim() : ''
    if (momentId === '') {
      sendJson(res, 400, { unavailable: 'Which moment?' })
      return
    }
    await ctx.gnomonKernel.appendSignal('moment:transcript-accepted', { momentId, by: 'owner' })
    sendJson(res, 200, { accepted: true })
  })

  api('/gnomon/api/assert', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'An assertion takes a POST.' })
      return
    }
    const body = await readBody(req, 8192)
    let entityKind = typeof body?.entityKind === 'string' ? body.entityKind.trim() : ''
    let canonicalName = typeof body?.canonicalName === 'string' ? body.canonicalName.trim() : ''
    const predicate = typeof body?.predicate === 'string' ? body.predicate.trim() : ''
    const object = typeof body?.object === 'string' ? body.object.trim().slice(0, 1000) : ''
    if (!ASSERT_KINDS.has(entityKind) || canonicalName === '' || predicate === '' || object === '') {
      sendJson(res, 400, { unavailable: 'An assertion needs entityKind (owner/person/project/tool/topic/goal), canonicalName, predicate and object.' })
      return
    }
    // The owner under any alias, any kind → the one owner entity (ownerAliases[0]).
    const aliases = ctx.gnomonKernel.getState()?.config.ownerAliases ?? []
    const isOwner = aliases.some((alias) => alias.trim().toLowerCase() === canonicalName.toLowerCase())
    if (isOwner && (entityKind === 'owner' || entityKind === 'person' || entityKind === 'topic')) {
      entityKind = 'owner'
      canonicalName = aliases[0]
    }
    // What the owner was looking at when they said it, when the surface knows.
    // An assertion has had no source event since this route was written, which
    // is why the Memory card's proof line reads "you told me" for all 96 of
    // them — correct, and the end of the trail. The asks card can do better:
    // its answer IS an event in the log, so an answer routed into memory keeps
    // a pointer to the question that produced it and the card can read back
    // what it wrote. `people-ask` already stamps its auto-route the same way.
    const sourceEventId = typeof body?.sourceEventId === 'string' && body.sourceEventId.trim() !== '' ? body.sourceEventId.trim() : null
    const entityId = makeEntityId(entityKind, canonicalName)
    await ctx.gnomonKernel.appendSignal('entity:fact-candidate', {
      entityKind,
      canonicalName,
      predicate,
      object,
      confidence: 100,
      provenance: 'assertion',
      entityId,
      sourceEventId,
      projectId: null,
    })
    sendJson(res, 200, { offered: true, entityId, triple: `${canonicalName} ${predicate} ${object}` })
  })

  /**
   * Stop the turn that is running, because the owner said so.
   *
   * Aborting the SSE read was never a stop: the comment on `/gnomon/api/turn`
   * says so outright — "the turn keeps running and lands in the log, because
   * the tokens are spent either way". So a shell command that hung, or a model
   * grinding through a tool loop, could not be called off from the one surface
   * the owner has. `agent.cancel` is the real thing, and dsh gives the cause a
   * first-class `user` variant, so "they stopped it" is durable in the log
   * rather than inferred from a turn that merely went quiet.
   *
   * `keepInbox: true` because this is "stop what you are doing", not "forget
   * everything I asked". It also keeps the note below, which is injected after
   * the cancel and would otherwise be swept out with the inbox.
   */
  api('/gnomon/api/stop', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Stopping takes a POST.' })
      return
    }
    const body = await readBody(req, 8192)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : ''
    if (sessionId === '') {
      sendJson(res, 400, { unavailable: 'Stopping needs a session.' })
      return
    }
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined || agent.status === 'disposed') {
      sendJson(res, 409, { unavailable: 'That session is not running.' })
      return
    }

    agent.cancel({ kind: 'user' }, { keepInbox: true })

    // What the next turn needs to know, in one line: that the silence was the
    // owner's doing and not a failure, and — when they said why — what they
    // actually wanted instead. Without it the model opens the next turn seeing
    // a half-finished tool chain and no idea whether to resume it.
    agent.inject(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: [
              'The owner stopped that turn themselves — it did not fail, and nothing is wrong.',
              note !== '' ? `They said: "${note}"` : null,
              'Do not silently start it again. Pick it up from what you already had, do what they asked instead, or ask what they want — briefly.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(note !== '' ? `Stopped: ${note}` : 'The owner stopped that turn') },
      }),
    )

    console.log(`[${PLUGIN}] ${sessionId} stopped by the owner${note !== '' ? ` — "${note}"` : ''}`)
    sendJson(res, 200, { stopped: true, note: note === '' ? null : note })
  })

  /** Stop the running job. The proactive plugin aborts its child and closes the record. */
  api('/gnomon/api/work/stop', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Stopping takes a POST.' })
      return
    }
    const body = await readBody(req, 4096)
    const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : ''
    if (jobId === '') {
      sendJson(res, 400, { unavailable: 'Which job?' })
      return
    }
    ctx.emit('gnomon/work-stop', { jobId })
    sendJson(res, 200, { stopping: true, jobId })
  })

  api('/gnomon/api/approve', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Answering takes a POST.' })
      return
    }
    const body = await readBody(req, 4096)
    const id = typeof body?.id === 'string' ? body.id : ''
    const outcome = body?.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
    const settle = pending.get(id)
    if (settle === undefined) {
      // Already answered, expired, or withdrawn. Not an error — a stale tab
      // answering a question that has moved on is inert, not a fault.
      sendJson(res, 200, { answered: false })
      return
    }
    settle(outcome)
    sendJson(res, 200, { answered: true, outcome })
  })

  console.log(`[${PLUGIN}] Gnomon's own client is serving / (dsh's frontend is no longer reachable)`)
}
