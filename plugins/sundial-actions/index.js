// @sundial/dsh-actions — what the assistant is allowed to DO, and the gate that
// governs it.
//
// The no-actuation constraint (D11) was lifted by owner decision on 2026-07-27;
// the almanac left the socket "designed empty on purpose" with a standing law
// for filling it — every action arrives through the same gate, shows its
// record, and takes the same three verdicts. This plugin is that socket:
//
//   - it registers Gnomon's internal action tools (claim / propose /
//     record_outcome, plus gnomon_run_shell), each of which emits a recorded,
//     overturnable event;
//   - it installs ONE `tools/pre-execute` gate whose SINGLE SOURCE OF TRUTH is
//     dsh's permission preset (the "Permissions" chip: read-only /
//     workspace-write / danger-full-access). The gate maps that preset onto
//     gnomon's own tools and — apart from adding a destructive-command refusal
//     to `bash` — leaves dsh's built-ins to dsh's native sandbox + approval,
//     which the same preset already drives. See gate.js for the full table.
//
// config.actions is DEMOTED to an optional per-capability override that can only
// TIGHTEN the preset-derived decision (never loosen), and only for gnomon's own
// tools. Read it in @sundial/helpers; see gate.js for how it composes.
import { execFile } from 'node:child_process'
import { appIn, awaitTool, shellOf, turnBegan, turnStart, wakes } from './await-tool.js'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { isIntegrationRead, loadSundialConfig, resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { getCalendarHelperPath } from '@sundial/helpers/sundial-paths.js'
import { mountIntegrations } from './integrations.js'
import { calendarCreateTool, reminderCreateTool } from './tools.js'
import { callFacts, callRecord, decideAction, decisionRecord, enterApp, escalate, judgedPlans, keyboardLook, GNOMON_TOOLS, finalAsk, finalOf, commandLine, touchesLine, judgedAction, neverRan, openedByOwner, outwardCall, recipientsOf, refusedFinal, rungOf, unverifiedNotice, egressAsk, egressOf, knownHostsOf, privateWords, testModeRuns, chatRead, UNKNOWN_SAY } from './gate.js'
import { callChat } from './call-chat.js'
import { internalTools } from './tools.js'
import { sandboxView } from '@sundial/helpers/sandbox.js'
import { runShellTool } from './run-shell.js'
import { webElement, webTools } from './web-tools.js'
import { filledApp, screenAsk, screenTools } from './screen-tools.js'
import { turnEnded } from './screen-stage.js'
import { pullUpTool } from './pull-up.js'
import { skillTool } from './skill.js'
import { rigSession, routeReplay } from './screen-pick.js'
import { hasRef, lookOf } from './screen-look.js'
import { stepsOf } from '@sundial/helpers/screen-routes.js'
import { NOTES_COMPACTION_CONFIG, NotesCompaction } from './chat-notes.js'
import { breakerOf, contextBegan, contextCalls } from './loop-breaker.js'
import { staleLine, staleTurn } from '@sundial/helpers/stale-turn.js'
import { REJECTED, saidNo, saidNoResult } from './said-no.js'
import { DECLARED_TOOLS } from './gate-tools.js'
import { benchRefusal } from '@sundial/helpers/bench-guard.js'

/**
 * Bench mode (lab/bench/agentdojo): plugins/sundial-bench declares AgentDojo's tools to this gate, each with its final kind
 * (gate-tools.js DECLARED_TOOLS), so a send or a transfer asks like any other final. Refused (thrown) unless this install is
 * the bench (helpers bench-guard.ts): on the owner's install nothing can be declared. Returns the declaration's removal.
 */
export function declareBenchTool(name, final, refusal = benchRefusal) {
  const refused = refusal()
  if (refused !== null) throw new Error(`a bench tool is declared only on the bench install: ${refused}`)
  if (GNOMON_TOOLS[name] !== undefined || DECLARED_TOOLS.has(name)) throw new Error(`${name} is already a tool the gate knows`)
  DECLARED_TOOLS.set(name, final ?? null)
  return () => DECLARED_TOOLS.delete(name)
}

export const name = 'sundial-actions'
// `approval` is injected so the gate can read the session's approval override
// for the custom/unknown-preset fallback. `shell` is dsh's confining
// ShellExecutor — gnomon_run_shell runs through it so an approved command obeys
// the active preset's sandbox (the same executor bash uses). `permissionPresets`
// is dsh's preset service — since 0.1.5 the effective preset is only reachable
// through it, so it has to be injected rather than imported as a function.
export const inject = ['tools', 'gnomonKernel', 'gnomonDb', 'approval', 'shell', 'permissionPresets']

/** A screen step checks itself (its own after-look says what changed): its `action:verified` row from its result, with no judge call. Null for any other tool. */
export function selfVerified(tool, result) {
  if (tool !== 'screen_act' && tool !== 'screen_undo') return null
  const failed = result?.isError === true
  return { tool, carriedOut: failed ? 'refused or failed' : 'performed', failed, isError: failed, outward: true, by: 'after-look' }
}

/** The app the last look read, unless that look was refused. */
const lookApp = (state) => (state?.marks?.lastLook && !state.marks.lastLook.refused ? state.marks.lastLook.app : undefined)

/** W5 step 10: the owner's auto mode, under the actions capability — Act runs alone only once actions have earned it and the owner said yes. */
export const autonomyOf = (state) => (state?.settings?.autonomy === 'act' && state?.autonomy?.levels?.actions?.level !== 'act' ? 'earning' : state?.settings?.autonomy)

export function apply(ctx, config = {}) {
  // Read once at apply; a config change is picked up on reload, the same
  // cadence every other plugin here uses. `overrides` lets a test inject.
  const loaded = loadSundialConfig()
  const actions = config.actions ?? loaded.actions
  // The owner's own services, mounted as MCP clients and governed by the gate
  // below. See integrations.js for why they are declared in Gnomon's config
  // rather than in the dsh profile.
  const integrations = config.integrations ?? loaded.integrations
  const reach = mountIntegrations(ctx, McpClient, integrations)

  // What Gnomon can reach, for the UI. The theme reads this rather than
  // re-deriving it, so the Instruments show the SAME verdicts the gate gives —
  // mounted or not (and why), and which of a server's tools are reads.
  ctx.provide('gnomonReach', {
    integrations: () => reach.map((r) => ({ ...r })),
    isRead: (serverName, rawTool) => {
      const integration = integrations.find((i) => i.name === serverName)
      return integration !== undefined && isIntegrationRead(integration, rawTool)
    },
    /**
     * What the gate WILL do with this tool under a given preset — the same
     * `decideAction` the pre-execute hook runs, with no args.
     *
     * The Reach card exists to tell the owner what Gnomon can do to their
     * services, and the only honest way to say that is to ask the gate rather
     * than to re-derive its ladder on a surface. A second copy of
     * `PRESET_POLICY` in the theme would be a second policy: it would agree
     * today and diverge the first time either changed, and it would diverge
     * silently, on the one card whose whole job is to be trusted.
     *
     * **A shell tool has no single verdict, and asking for one lied.** Its
     * decision depends on the COMMAND: `destructiveDeny` runs first and
     * `classifyCommand('')` is destructive by design ("empty or non-string
     * command"), so calling this with no args reported `gnomon_run_shell` as
     * permanently refused at every preset — which is false, and on a
     * permission card is the worst direction to be false in. A harmless real
     * command is passed instead so the preset ladder is evaluated honestly,
     * and the answer is tagged `argDependent` so the card can say the rest:
     * a destructive command is refused whatever the preset says.
     */
    verdict: (toolName, preset) => {
      const shell = GNOMON_TOOLS[toolName]?.shell === true || toolName === 'bash'
      const decision = decideAction({
        toolName,
        args: shell ? { command: 'true' } : undefined,
        preset,
        approvalOverride: undefined,
        actions,
        resolveActionPolicy,
        integrations,
        isIntegrationRead,
        autonomy: autonomyOf(ctx.gnomonKernel?.getState()),
      })
      return shell ? { ...decision, argDependent: true } : decision
    },
    /** The presets the gate knows how to answer for, strictest first. */
    presets: () => ['read-only', 'workspace-write', 'danger-full-access'],
  })
  // Bench mode: the one way a tool from another plugin reaches this gate (declareBenchTool above, bench install only).
  ctx.provide('gnomonGate', { benchRefusal: () => benchRefusal(), declareBenchTool: (name, final) => declareBenchTool(name, final) })

  // Register the internal tools the config permits. An `off` internal tool is
  // never registered, so the model cannot see or call it — deny-at-the-gate is
  // the backstop, not the only line.
  const appendSignal = (type, payload) => ctx.gnomonKernel.appendSignal(type, payload)

  // The internal writes, plus gnomon_run_shell — an outward tool, so it is
  // only registered when the owner has taken run_shell off `off`. Even then it
  // refuses destructive commands at execute time (run-shell.js), independent of
  // whether the policy is `ask` or `auto`.
  // Registration is process-level; the gate does the per-session governing. A
  // config.actions `off` still skips registration entirely — a legitimate
  // coarse opt-out (the tool never appears), which only ever tightens.
  const getState = () => ctx.gnomonKernel.getState()
  // A wait ends when the fold says something changed (the kernel's own event, after each folded signal), not on a fast poll.
  const { wake, changed } = wakes()
  ctx.effect(() => ctx.on('gnomon/changed', wake))
  // Per chat, its last gnomon_run_shell, from the fold (`shell:started`, rules shell-jobs.ts), so it holds after a restart:
  // an empty gnomon_await right after it waits for its job, or says none started.
  const lastShell = (session) => shellOf(getState(), session ?? '')
  /**
   * Doc 16: one look's row (`screen:looked`, already sanitized at ingest) from the log, by its id or by the act it followed (`field: 'after'`). A few seconds around `at`, the look's own time, else the last minute.
   * `field: 'tag'`: the newest look of the last ten minutes of the app run with that tag (with `ref`: the newest that lists it); an older look with
   * no tag, of the last two minutes, whose id ends in it. `type: 'screen:ocr'` reads the screen-text sensor's newest row instead.
   */
  const readLook = async (id, { field = 'id', at, type = 'screen:looked', ref } = {}) => {
    const t = Date.parse(at ?? '')
    const tag = field === 'tag'
    if (tag) {
      const q = ctx.gnomonDb.queries
      const [from, to, has] = [new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() + 5_000).toISOString(), `"tag":${JSON.stringify(id)}`]
      const total = await q.countSignalsInRange(from, to, [type], has)
      const runs = await q.getSignalsInRange(from, to, 20, [type], Math.max(0, total - 20), has)
      const run = runs.findLast((row) => row.data?.tag === id && (!ref || hasRef(row.data, ref)))?.data
      if (run || total) return run ?? null
    }
    const [from, to] = Number.isNaN(t) ? [Date.now() - (tag ? 120_000 : 60_000), Date.now() + 5_000] : [t - 5_000, t + 5_000]
    // A tag is four characters a frame's numbers can hold too: the closing quote of the id narrows the search.
    const rows = await ctx.gnomonDb.queries.getSignalsInRange(new Date(from).toISOString(), new Date(to).toISOString(), type === 'screen:looked' ? 8 : 50, [type], 0, tag ? `${id}"` : id)
    // By tag, only a look with no tag of its own (an older row), and with the ref when one is asked.
    return rows.findLast((row) => (tag ? !row.data?.tag && String(row.data?.id ?? '').endsWith(id) && (!ref || hasRef(row.data, ref)) : row.data?.[field] === id))?.data ?? null
  }
  /** The steps screen_act took in one app (`screen:step`): what Gnomon learned there (`@sundial/helpers/screen-routes.js`, which the turn brief reads too). */
  const readSteps = (app) => stepsOf(ctx.gnomonDb.queries, app, Date.now())
  /** experiments.screenFast and screenFastRoutes (screen-pick.js): Jev in the turn, budgeted and audited on the screen purpose. */
  const judge = async (state, questions, set) => (await ctx.gnomonKernel.judgeNow({ purpose: 'screen', questionSetId: set, momentId: null, state, questions, caller: 'screen_act' }))?.answers ?? null
  /** The route keys of an app's current `routeWorks` facts (rules route-promote.ts), the second way a route qualifies for replay. */
  const readWorks = async (app) => (await ctx.gnomonDb.queries.getCurrentEntityFacts(`app:${String(app).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`)).filter((f) => f.predicate === 'routeWorks').map((f) => f.object)
  const route = routeReplay({ judge, readSteps, readWorks })
  /** config.json as written, for the one field the resolved config does not carry (`web.knownHosts`); {} when it cannot be read. */
  /**
   * An approval is never spent on a call that cannot run. dsh validates a call's arguments at dispatch, after
   * the ask (`tools/pre-execute`, then the approval, then `execute`), so the gate checks them before it asks.
   * A screen act is asked with the step as the code reads it (what is pressed, where, the value), not the
   * model's sentence about it. A check that fails to run changes nothing: the ask stands.
   */
  const planned = (exec) => screenAsk(exec.name, exec.args ?? exec.arguments ?? {}, getState(), readLook, route, exec.agent?.session?.snapshotEvents?.() ?? [], exec.agent?.session?.id).catch(() => ({}))
  const asked = async (exec, ask, plan, final, more = null) => {
    try {
      const args = exec.args ?? exec.arguments ?? {}
      const schema = ctx.tools.schemas(exec.agent).find((tool) => tool.name === exec.name)?.parameters
      const violations = schema ? validateJsonSchemaValue(schema, args, '') : []
      if (violations.length > 0) return { kind: 'deny', reason: `invalid arguments: ${violations.join('; ')}` }
      const { error, line } = plan ?? (await planned(exec))
      // A screen ask shows the steps as the code reads them; a shell ask its command, so nothing is approved unseen. A final adds
      // its kind, recipients and path in the one format the rig parses (gate.js finalAsk).
      if (error) return { kind: 'deny', reason: error }
      if (final) return { ...ask, reason: finalAsk(final, { line, command: args.command, path: final.path, window: final.window }) }
      // After " · ", so the step line the record and the rig read (server.js stepLine, yes.mjs parse) stays the step.
      if (line) return { ...ask, reason: more ? `${line} · ${more}` : line }
      // A shell ask: what the command touches (paths, hosts), then the command itself, last, as the rig reads it.
      return typeof args.command === 'string' && args.command !== '' ? { ...ask, reason: [ask.reason, touchesLine(args.command), commandLine(args.command)].filter(Boolean).join(' · ') } : ask
    } catch {
      return ask
    }
  }
  // experiments.screenStage is read from config.json at every screen call, so a bench flips it with no restart.
  const running = (app) => new Promise((done) => execFile('/usr/bin/lsappinfo', ['list'], { timeout: 2000 }, (error, out) => done(!error && appIn(out, app))))
  // When an app's process started (ms), as the rig's `late` check reads it: pgrep -x, then ps lstart; null on any failure.
  const run = (file, args) => new Promise((done) => execFile(file, args, { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }, (error, out) => done(error ? '' : String(out).trim())))
  const startedAt = async (app) => {
    const pid = (await run('/usr/bin/pgrep', ['-x', app])).split('\n')[0]
    const at = pid ? Date.parse((await run('/bin/ps', ['-o', 'lstart=', '-p', pid])).replace(/\s+/g, ' ')) : NaN
    return Number.isFinite(at) ? at : null
  }
  const x = loadSundialConfig().experiments
  // Set 3 R3: a look or an act a chat's call asks the app for is on the record under that chat first (call-chat.js).
  const chat = callChat(appendSignal, (command) => ctx.gnomonKernel.appChannel.send(command))
  const screen = screenTools(appendSignal, getState, chat.send, readLook, readSteps, { judge, route, changed, stageOn: () => loadSundialConfig().experiments.screenStage === true, running, say: (line) => ctx.emit('gnomon/step-line', line), held: (hand) => ctx.emit('gnomon/hand', hand), offer: { find: x.screenFast === true }, files: (from, to) => ctx.gnomonDb.queries.getAllSignalsInRange(from, to, ['file:changed']) })
  // The turn that staged the windows is over: each goes back where it was.
  // A turn is over (stopped too): that chat's windows go back. At start, every window an earlier run left placed goes back (the app still holds their frames).
  ctx.effect(() => ctx.on('session/event', turnEnded(screen.stage)))
  ctx.gnomonKernel.appChannel.send({ type: 'unplace' })
  // gnomon_await's look after a wait: screen_look through dsh's pipeline (its audit and its row), a child of the await call.
  const lookAt = async (app, exec) => {
    const r = await ctx.tools.execute({ callId: `${exec?.callId}:screen_look`, rootCallId: exec?.rootCallId ?? exec?.callId, name: 'screen_look', arguments: { app }, agent: exec?.agent, parent: exec?.token, signal: exec?.signal })
    if (!r || r.isError) return null
    return typeof r.value === 'string' ? r.value : (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null
  }
  const candidates = [
    ...internalTools(appendSignal, getState),
    runShellTool(appendSignal, config.cwd ?? process.cwd(), ctx.shell),
    // Wait on a fact the fold already holds, instead of sleeping (await-tool.js).
    awaitTool(getState, changed, lastShell, running, async () => (await ctx.gnomonDb.queries.getRecentSignals(50, 'window')).filter((row) => row.eventType === 'changed').map((row) => ({ app: String(row.data?.processName ?? ''), at: row.capturedAt })), startedAt, screen.titleOf, lookAt, (row) => appendSignal('await:shelved', row)),
    calendarCreateTool(appendSignal, getCalendarHelperPath(), execFile),
    reminderCreateTool(appendSignal, getCalendarHelperPath(), execFile),
    // Web tasks in Gnomon's own browser: web_page reads, web_act acts (outward).
    ...webTools(appendSignal),
    // Plan 15 steps 6 to 8: marks, guides and one act on the real screen, through Sundial.app.
    ...screen,
    // "Pull it up" (pull-up.js): find, open and ring in one call.
    pullUpTool({ tools: ctx.tools, getState, appendSignal, readLook, readRecent: (from, to) => ctx.gnomonDb.queries.getAllSignalsInRange(from, to, ['window:changed', 'input:activity', 'action:decided', 'action:performed', 'overlay:summoned', 'overlay:dismissed']) }),
    skillTool({ tools: ctx.tools, getState, readSteps, readWorks, appendSignal }),
  ]
  for (const tool of candidates) {
    const cap = GNOMON_TOOLS[tool.name]
    if (cap && resolveActionPolicy(actions, cap.kind, cap.tool) === 'off') continue
    ctx.effect(() => ctx.tools.register(chat.wrap(tool)))
  }

  // Compaction with each chat's notes as its summary (chat-notes.js). It
  // replaces dsh-base's compaction-basic row, which the profile turns off: two
  // engines would both compact.
  ctx.plugin(NotesCompaction, NOTES_COMPACTION_CONFIG)

  // The gate. Every tool call the agent makes passes through here first.
  // `next()` yields the decision the rest of the pipeline would reach (default
  // allow, or another plugin's policy); this replaces it only when Gnomon has
  // something stricter to say. It never LOOSENS another decision — a deny/ask
  // from downstream is returned untouched — so composing policies can only
  // tighten, which is the safe direction.
  //
  // The active PERMISSION PRESET is read per-call from the session;
  // gnomon derives every gnomon-tool verdict from it, so the one chip in the UI
  // governs both dsh's built-ins (natively) and gnomon's tools (through here).
  //
  // dsh 0.1.5 turned the pure `effectivePermissionPreset(events)` into
  // `ctx.permissionPresets.current(session)`, which returns the literal
  // `'custom'` where the old function returned undefined. gate.js treats both
  // the same (unknown name → conservative rung), so nothing downstream changed.
  ctx.effect(() =>
    ctx.on('tools/pre-execute', async (exec, next) => {
      const session = exec.agent?.session
      const preset = session ? ctx.permissionPresets?.current(session) : undefined
      const approvalOverride = session ? ctx.approval?.overrideOf(session) : undefined

      // The loop breaker and the shell- and screen-hunt caps (loop-breaker.js), counted from this chat's own log, before an ask is spent.
      // Its `action:decided` row carries `breaker`, which the self-review (rules self-review.ts) reads as a ripe cluster.
      // A turn that sat with nobody behind it (stale-turn.ts, from the same log) acts no more: it says so in one line and ends.
      const quiet = staleTurn(session?.snapshotEvents?.(), Date.now())
      if (quiet !== null) {
        console.log(`[sundial-actions] deny ${exec.name} [stale turn, ${Math.round(quiet / 1000)} s still]`)
        return { kind: 'deny', reason: staleLine(quiet) }
      }
      const stop = breakerOf(exec.name, exec.args ?? exec.arguments, session?.snapshotEvents?.() ?? [])
      if (stop) {
        console.log(`[sundial-actions] deny ${exec.name} [breaker=${stop.breaker}]: ${stop.reason}`)
        const testMode = ctx.gnomonKernel?.getState()?.config?.experiments?.screenActUnasked === true
        void appendSignal('action:decided', { ...decisionRecord(exec, { preset, testMode, facts: { app: stop.app } }, stop), breaker: stop.breaker, ...(session?.id ? { sessionId: session.id } : {}) })
        return { kind: 'deny', reason: stop.reason }
      }

      // A ref press names nothing in its arguments: the plan reads its name from the look, so a final by ref is still a final.
      const plan = exec.name === 'screen_act' || exec.name === 'screen_undo' ? await planned(exec) : undefined
      const state = ctx.gnomonKernel?.getState()
      // A replayed route is judged on its steps (typing, a private app), as if the model had sent them.
      const [args, steps] = [plan?.replay ? { ...(exec.args ?? exec.arguments), steps: plan.replay } : exec.args ?? exec.arguments, plan?.plans ?? (plan?.verb ? [plan] : [])]
      // Run 138: Return on a Discard the keyboard was already in. The thing the last look of that app has the keyboard in goes first.
      // Run 145: when the last look is of another app, this chat's last act result in that app (its after-look, the `focus:` line) counts.
      const keyed = enterApp(steps)
      const look = state?.marks?.lastLook
      const where = keyboardLook(state, session?.id, keyed)
      const seen = where ? lookOf(await readLook(where.id, where).catch(() => null)) : null
      // Run 234 T25: and in a browser, a Return in a one-line text field carries the form's final button the look shows.
      const plans = judgedPlans(steps, seen)
      // A ref step types in the app of the last look; a refused look (a private app) resolves to nothing, so typing there is refused.
      // A step with no app is judged in the app screen_act fills in for it (run 129).
      const cwd = config.cwd ?? process.cwd()
      const events = session?.snapshotEvents?.() ?? []
      const turnAt = turnStart(events, true)
      // Set 3 R3: this chat's private read while its text can still be in the model's context: across turns, until the chat compacts
      // past it (run 202); turnAt above stays for refusedFinal. After one, a call that carries data off the Mac also checks the
      // distinctive words of the chat's private reads still in context (files, looks, services, the record; newest first, kept in
      // memory for this decision only) and the known hosts of the resolved config (web.knownHosts).
      const readPrivate = chatRead(state, session?.id, { contextAt: contextBegan(events), turnAt: turnBegan(events) })
      const privateText = () => contextCalls(events).filter((c) => c.name === 'screen_look' || callFacts({ toolName: c.name, args: c.args, integrations, isIntegrationRead, cwd }).reads).map((c) => c.text).reverse()
      const egressOpts = readPrivate && egressOf(exec.name, args) ? { words: privateWords(privateText()), hosts: knownHostsOf(loadSundialConfig()) } : {}
      const facts = callFacts({ toolName: exec.name, args, integrations, isIntegrationRead, webElement, lookApp: lookApp(state), fill: (step) => filledApp(step, state, session?.id), plans, cwd, ...egressOpts })
      // The ask names the final's target; a screen send, its recipients: the To, Cc and Bcc the last look of that app shows.
      const named = finalOf(exec.name, args, webElement, plans)
      // The last look of the final's app: its window titles the ask (Set 2 R1), and a send's To, Cc and Bcc are its recipients.
      const front = named?.via === 'screen' && look && !look.refused && look.app === named.app ? lookOf(await readLook(look.id, { at: look.at }).catch(() => null)) : null
      const sent = named?.kind === 'send' && front ? finalOf(exec.name, args, webElement, plans, recipientsOf(front)) : named
      // A delete or discard on screen names the document the app has in front, when the window says one.
      const active = state?.window?.active
      // AX gives a file:// URI; its escapes (%20) are left as they are.
      const doc = String(active?.documentPath ?? '').replace(/^file:\/\/(?:localhost)?/, '')
      const path = ['delete', 'discard'].includes(sent?.kind) && sent.app && active?.processName === sent.app && doc.startsWith('/') ? { path: doc } : {}
      const final = sent && { ...sent, ...path, ...(front?.window ? { window: front.window } : {}) }
      // W3: the gate's inputs, the arguments reduced to the facts a verdict reads.
      const inputs = {
        preset,
        approvalOverride,
        // config.actions from the config in the log, so a tightening applies at once.
        actions: ctx.gnomonKernel?.getState()?.config?.actions ?? actions,
        // The owner's own dial, under every verdict: below "act", anything that
        // reaches past this record stops for their nod; at "act", what Gnomon starts unasked
        // waits until actions have earned it (W5); the owner's own turn or preset is their yes.
        autonomy: autonomyOf(ctx.gnomonKernel?.getState()),
        // S10: a notice-opened turn may not speak for the owner.
        ownerTurn: typeof session?.snapshotEvents === 'function' ? openedByOwner(session.snapshotEvents()) : undefined,
        facts,
        // The owner's switch for unattended runs: a plain screen act goes unasked; a final still asks (gate.js underFinal).
        testMode: state?.config?.experiments?.screenActUnasked === true,
        // Round 3: the ladder's rung for this tool in the one app the plan read (gate.js rungOf); a step the plan did not read has none.
        earned: plan?.line && facts.app ? rungOf(state, exec.name, facts.app) : null,
        // A rig test chat writes nothing to the owner's record; a final refused in this turn stays refused (gate.js fenced).
        rig: rigSession(state, session?.id),
        // S4: unless the rig chat has a live sandbox, where the daily tools run into it (gate.js SANDBOXED).
        sandbox: sandboxView(state, session?.id) !== null,
        refused: refusedFinal(state, session?.id, turnAt),
        // Set 3 R3: a web call carrying data out after it asks (gate.js underEgress).
        readPrivate,
      }
      // An unattended test run (the owner's switch, approvals off): nobody answers a question, and run 10 waited 187 s on one.
      if (exec.name === 'ask_user_question' && inputs.testMode && approvalOverride === 'never') return { kind: 'deny', reason: 'Nobody can answer a question during this unattended run: decide yourself with the safest choice, or end your answer by saying what you need.' }
      const decision = decideAction({ toolName: exec.name, resolveActionPolicy, ...inputs })
      // Run 11: an ask nobody can answer came back as "the user rejected", and the model took it as the owner's no.
      const unanswered = (ask) => (inputs.testMode && approvalOverride === 'never' ? { kind: 'deny', reason: `${ask.reason} Nobody can give that nod during this unattended run (the owner did not refuse): take a way that does not need it, or end your answer by saying what you need.` } : null)

      // Gnomon's own tools, bash and an outward service call always, plus any
      // non-allow verdict, on the record with the inputs that decided it (W3),
      // so a surprised owner can see why a call did or did not run and the
      // verdict can be refolded. Quiet on the flood of allowed dsh reads.
      // A read outside the workspace is on the record too (privateReads folds it per chat), and so is every web call that carries a
      // data shape, asked or not: the rig counts egress-without-an-ask from these rows, not from the saved URL (its query is stripped).
      if (decision.kind !== 'allow' || exec.name === 'bash' || exec.name.startsWith('gnomon_') || inputs.facts.integration === 'write' || inputs.facts.reads || inputs.facts.egress?.shapes.length) {
        console.log(
          `[sundial-actions] ${decision.kind} ${exec.name} [preset=${preset ?? 'none'}]` +
            (decision.reason ? `: ${decision.reason}` : ''),
        )
        void appendSignal('action:decided', decisionRecord(exec, inputs, decision))
      }

      // J4.1: the second key. A call the code would allow goes to the judge;
      // outward or irreversible above its threshold becomes an ask. The judge
      // never loosens, and its silence changes nothing.
      let judged = null
      if (decision.kind === 'allow' && judgedAction(exec.name) && typeof ctx.gnomonKernel?.classifyAction === 'function') {
        judged = await ctx.gnomonKernel.classifyAction(exec.name, exec.args ?? exec.arguments).catch(() => null)
        if (judged) {
          const final = escalate(decision, judged, exec.name)
          void appendSignal('action:classified', { tool: exec.name, level: judged.level, p: judged.p, stakes: judged.stakes, code: decision.kind, final: final.kind })
          if (final.kind !== 'allow') {
            console.log(`[sundial-actions] ${final.kind} ${exec.name}: ${final.reason}`)
            return final.kind === 'ask' ? unanswered(final) ?? asked(exec, final, plan) : final
          }
        }
      }

      // A refusal is on the record as its `action:decided`; the call's own row comes only when it runs.
      if (decision.kind === 'allow') return next()
      // The owner's switch (experiments.screenActUnasked): a plain screen act that would ask runs at once (gate.js testModeRuns).
      if (testModeRuns(exec.name, decision, inputs.testMode, facts, Boolean(plan?.line))) return next()
      // Round 3: a plain ask says how far it is from not asking any more in that app.
      const rung = inputs.earned
      // 2026-11-17: a press on a button whose words Gnomon does not know says so, and never earns (gate.js UNKNOWN_SAY).
      const more = facts.unknownButton && facts.final === null ? UNKNOWN_SAY : rung && !rung.earned && facts.final === null ? `${rung.k - rung.yes} more ${rung.k - rung.yes === 1 ? 'yes' : 'yeses'} until Gnomon stops asking for this in ${rung.app}` : null
      // Set 3 R3: an egress ask names what it sends and where (the record keeps the gate's own reason).
      const ask = decision.egress ? { ...decision, reason: egressAsk(exec.name, args, inputs.readPrivate, egressOpts) ?? decision.reason } : decision
      return decision.kind === 'ask' ? unanswered(ask) ?? asked(exec, ask, plan, final, more) : decision
    }),
  )

  // K0.1 — every tool call on the record, not only Gnomon's own.
  //
  // `action:performed` existed and meant "I did a thing", and only two tools
  // ever wrote it: `run_shell` and `calendar_create`. So of the record's 120
  // action rows, **119 were `run_shell` and one was `calendar_create`** — not
  // one call to a connected service had ever been recorded, and the Reach card
  // had to close with a section saying so. The fix needed no new machinery,
  // because there is already exactly one place every call passes: the gate.
  //
  // Written HERE and not in each tool, for the reason the gate itself is here
  // — a second writer is a second definition of "a call happened", and an MCP
  // tool is not Gnomon's code to put one in.
  //
  // **The row carries the FACT of the call and never its arguments.** A tool's
  // arguments are arbitrary text from a model, and this is a record of what
  // Gnomon reached for, not a copy of what it said. `run_shell` still logs its
  // command because a shell command IS the action, and `calendar_create` still
  // logs the event it made because only the tool can see it — those two rows
  // are DETAIL and carry no `outcome`, so a reader counting calls filters on
  // `outcome` being present and never double-counts. That is one derived
  // field rather than a list of tools to skip, which would drift the first
  // time a tool learned to report itself.
  const recordCall = (exec, outcome, reason = null) => void appendSignal('action:performed', callRecord(exec, outcome, reason))

  // A refused ask reads as the act refused (said-no.js), not dsh's "the user rejected tool X". A denial passes post-execute too.
  ctx.effect(() =>
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (result?.isError !== true || !REJECTED.test((result.content ?? []).map((b) => b?.text ?? '').join(''))) return next()
      const plan = exec.name === 'screen_act' ? await planned(exec) : undefined
      const final = finalOf(exec.name, exec.args ?? exec.arguments, webElement, plan?.plans ?? (plan?.verb ? [plan] : []))
      const timeout = ctx.gnomonKernel?.getState()?.approvals?.recent?.some((a) => a.callId === exec.callId && a.by === 'timeout') === true
      return { kind: 'block', feedback: [{ type: 'text', text: `Error: ${saidNo(exec.name, final, timeout)}` }] }
    }),
  )

  // The outcome of everything that was allowed to run. Separate from the J4.2
  // verify hook below, which only fires for judged actions and asks a model a
  // question; this one asks nothing and fires for every call.
  ctx.effect(() =>
    ctx.on('tools/result', (exec, result) => {
      recordCall(exec, result?.isError === true ? 'failed' : 'ok')
    }),
  )

  // J4.2: verify after acting. Every judged action's result goes back to the
  // judge; a result that does not show the action happened raises one notice
  // through the ordinary gate. An observer, not a waterfall: it can never
  // change or block the result the model already has.
  ctx.effect(() =>
    ctx.on('tools/result', (exec, result) => {
      if (!judgedAction(exec.name) || typeof ctx.gnomonKernel?.verifyAction !== 'function') return
      const args = exec.args ?? exec.arguments
      // Only an outward or irreversible call is worth the judge's second look and a notice.
      const what = outwardCall(exec.name, args, (server, tool) => {
        const integration = integrations.find((i) => i.name === server)
        return integration === undefined ? undefined : isIntegrationRead(integration, tool)
      })
      if (what === null || neverRan(result) || saidNoResult(result)) return
      const own = selfVerified(exec.name, result)
      if (own) return void appendSignal('action:verified', own).catch(() => {})
      void (async () => {
        const verdict = await ctx.gnomonKernel.verifyAction(exec.name, args, { isError: result?.isError === true, value: result?.value ?? result?.content ?? null }).catch(() => null)
        if (!verdict) return
        // `outward` marks a verdict under today's rule: before 2026-09-29 reads, no-ops and refusals were judged too, and row 11 does not count those.
        await appendSignal('action:verified', { tool: exec.name, carriedOut: verdict.carriedOut, failed: verdict.failed, isError: result?.isError === true, outward: true })
        if (verdict.failed) await appendSignal('notice:candidate', unverifiedNotice(exec.name, what, verdict.carriedOut, new Date().toISOString()))
      })()
    }),
  )
}
