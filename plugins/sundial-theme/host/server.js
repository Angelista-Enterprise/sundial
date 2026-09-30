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
import { route } from './http.js'
import { mountWeb } from './api-web.js'
import { mountConfig } from './api-config.js'
import { mountWrites } from './api-writes.js'
import { mountSessions } from './api-sessions.js'
import { mountRead } from './api-read.js'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getSundialHome } from '@sundial/helpers/config.js'
import { blankSignInLinks, ownToken } from './signin-log.js'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { chatDefault } from '@sundial/helpers/llm-providers.js'
import { openAsk as openAskOf } from '@sundial/helpers/loops.js'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { threadModelOf } from '../shell/thread-model.js'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { briefCause, liveFrames, streamFrames } from '../shell/frames.js'
import { nowSnapshot } from '@sundial/kernel/now.js'

/**
 * How long changed table names are gathered before one `stale` frame goes out.
 *
 * The fold already coalesces per tick; this is the second, coarser bucket, so a
 * burst of folds (a replay, a nightly pass) costs one frame a second rather
 * than one per event. Short enough that the board still reads as live.
 */
const STALE_WINDOW_MS = 1_000

/** The browser's folder: the pages and every module the page loads. Host code (this folder) is never served. */
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell')
const PLUGIN = 'sundial-shell'

/** An unanswered approval expires rather than holding a tool call forever. */
const APPROVAL_TTL_MS = 300_000

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/**
 * Every servable file in the browser's folder (`shell/`), by route.
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
ASSETS['/gnomon/app/vocab.js'] = [relative(HERE, createRequire(import.meta.url).resolve('@sundial/helpers/vocab.js')), TYPES['.js']] // from outside this folder: the page's import map names it

/**
 * Mount the shell.
 *
 * @param ctx the plugin context — needs webServer, agents, agentDefaultModel,
 *   sessionQuery, sessions.
 * @param cwd the working directory new sessions are created in.
 */
export function mountShell(ctx, { cwd = process.cwd(), home = getSundialHome() } = {}) {
  // Every route goes through the fence (host/guard.js): a same-origin, signed-in browser, or this process.
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
        const tool = String(req.toolName ?? 'a tool')
        // W3: every approval on the record, asked and answered, and by whom.
        const record = (type, payload) => void Promise.resolve(ctx.gnomonKernel.appendSignal(type, { approvalId: id, sessionId, tool, ...payload })).catch(() => {})
        record('approval:asked', {})
        return await new Promise((resolve) => {
          const settle = (outcome, by = 'owner') => {
            if (!pending.has(id)) return
            pending.delete(id)
            waiting.delete(id)
            clearTimeout(timer)
            req.signal?.removeEventListener?.('abort', onAbort)
            push(sessionId, { type: 'approval-closed', id, outcome })
            record('approval:answered', { answer: outcome, by })
            resolve(outcome)
          }
          const timer = setTimeout(() => settle('rejected', 'timeout'), APPROVAL_TTL_MS)
          // The asker withdrew the question (the turn was cancelled). Settle
          // 'cancelled' so the audit records what actually happened rather than
          // a refusal the owner never gave.
          const onAbort = () => settle('cancelled', 'asker')
          req.signal?.addEventListener?.('abort', onAbort, { once: true })

          pending.set(id, settle)
          const frame = {
            type: 'approval',
            id,
            toolName: tool,
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
    const open = openAskOf(ctx.gnomonKernel.getState())
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

  // The observation that woke the companion — visible the moment it lands,
  // before the model has finished deciding how to put it. Delivery says which
  // notice it was, so the block the words land in can carry a verdict back to
  // exactly this notice (`/gnomon/api/feedback`).
  ctx.effect(() => ctx.on('gnomon/noticed', ({ observation, noticeKey, sessionId } = {}) => sessionId === null && observation && broadcast({ type: 'noticed', text: observation, at: new Date().toISOString(), noticeKey })))

  // What Gnomon said unprompted. The companion's own assembled reply is the
  // thing worth showing — the notice that provoked it is the reason, and the
  // reply is what a colleague would actually have said.
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (session?.id !== COMPANION_SESSION_ID) return
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
        // The notice's own ask id first (W1: the cause the turn's brief folded,
        // so it survives a restart); the open ask only when the notice carried
        // none (a question the companion asked in prose on its own).
        const cause = briefCause(ctx.gnomonKernel.getState(), COMPANION_SESSION_ID)
        if (text.trim() !== '') broadcast({ type: 'said', text, at: new Date().toISOString(), session: COMPANION_SESSION_ID, askId: cause.askId ?? openAsk()?.askId ?? null, noticeKey: cause.noticeKey })
      }
    }),
  )

  /** W1: a turn's brief, injected as the context it is; `summary` is its one-line account. */
  const briefMessage = (brief, summary = brief.present) => createUserMessage({ content: [{ type: 'text', text: brief.text }], source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(summary) } })

  function liveText(message) {
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  /** The model this deployment is on, as both the agent options and a label. */
  const selection = () => chatDefault(ctx.agentDefaultModel.currentSelection(), ctx.gnomonKernel?.getState()?.config.llm)

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

  async function agentFor(sessionId, { create = false, mustExist = false } = {}) {
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
        if (mustExist || !/not found/i.test(error instanceof Error ? error.message : String(error))) throw error
        console.log(`[${PLUGIN}] session ${sessionId} has no log; creating it`)
        handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup })
      }
    }
    if (typeof handle.dispose === 'function') handles.set(sessionId, handle.dispose)
    return handle.agent
  }

  // W2: any thread, for the proactive plugin's addressed follow-ups — resumed
  // with its own remembered model, and never re-created: a thread that is gone
  // throws, and the notice is dropped as `session-gone`.
  ctx.provide('gnomonThreads', { agentFor: (sessionId) => agentFor(sessionId, { mustExist: true }) })

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

  const api = (path, handler) => route(ctx, path, handler, PLUGIN)

  // The Mac app's window must never sign in with a previous run's link (see
  // signin-log.js): the old ones go now, this run's own at shutdown.
  const signInLog = join(home, 'logs', 'sundial.log')
  const token = ownToken(ctx.connection)
  if (token !== null) blankSignInLinks(signInLog, token)
  ctx.effect(() => () => blankSignInLinks(signInLog), 'sundial-shell sign-in links')

  console.log(`[${PLUGIN}] Gnomon's own client is serving / (dsh's frontend is no longer reachable)`)

  const shell = { agentFor, api, briefMessage, broadcast, handles, home, live, openAsk, openQuestions, pending, PLUGIN, readSnapshot, rememberedModel, selection, snapshot, snapshots, stoppers, threadModel, threadModels, turnClosed, turning, turnOpened, waiting, watch }
  mountSessions(ctx, shell)
  mountRead(ctx, shell)
  mountWrites(ctx, shell)
  mountConfig(ctx, shell)
  mountWeb(ctx, shell)

}
