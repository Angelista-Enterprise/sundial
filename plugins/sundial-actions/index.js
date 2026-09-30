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
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { isIntegrationRead, loadSundialConfig, resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { getCalendarHelperPath } from '@sundial/helpers/sundial-paths.js'
import { mountIntegrations } from './integrations.js'
import { calendarCreateTool, reminderCreateTool } from './tools.js'
import { callFacts, callRecord, decideAction, decisionRecord, escalate, GNOMON_TOOLS, judgedAction, openedByOwner, outwardCall, unverifiedNotice } from './gate.js'
import { internalTools } from './tools.js'
import { runShellTool } from './run-shell.js'
import { webTools } from './web-tools.js'

export const name = 'sundial-actions'
// `approval` is injected so the gate can read the session's approval override
// for the custom/unknown-preset fallback. `shell` is dsh's confining
// ShellExecutor — gnomon_run_shell runs through it so an approved command obeys
// the active preset's sandbox (the same executor bash uses). `permissionPresets`
// is dsh's preset service — since 0.1.5 the effective preset is only reachable
// through it, so it has to be injected rather than imported as a function.
export const inject = ['tools', 'gnomonKernel', 'approval', 'shell', 'permissionPresets']

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
  const candidates = [
    ...internalTools(appendSignal, getState),
    runShellTool(appendSignal, config.cwd ?? process.cwd(), ctx.shell),
    calendarCreateTool(appendSignal, getCalendarHelperPath(), execFile),
    reminderCreateTool(appendSignal, getCalendarHelperPath(), execFile),
    // Web tasks in Gnomon's own browser: web_page reads, web_act acts (outward).
    ...webTools(appendSignal),
  ]
  for (const tool of candidates) {
    const cap = GNOMON_TOOLS[tool.name]
    if (cap && resolveActionPolicy(actions, cap.kind, cap.tool) === 'off') continue
    ctx.effect(() => ctx.tools.register(tool))
  }

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
        facts: callFacts({ toolName: exec.name, args: exec.args ?? exec.arguments, integrations, isIntegrationRead }),
      }
      const decision = decideAction({ toolName: exec.name, resolveActionPolicy, ...inputs })

      // Gnomon's own tools, bash and an outward service call always, plus any
      // non-allow verdict, on the record with the inputs that decided it (W3),
      // so a surprised owner can see why a call did or did not run and the
      // verdict can be refolded. Quiet on the flood of allowed dsh reads.
      if (decision.kind !== 'allow' || exec.name === 'bash' || exec.name.startsWith('gnomon_') || inputs.facts.integration === 'write') {
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
            return final
          }
        }
      }

      // A refusal is on the record as its `action:decided`; the call's own row comes only when it runs.
      if (decision.kind === 'allow') return next()
      return decision
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
      if (what === null) return
      void (async () => {
        const verdict = await ctx.gnomonKernel.verifyAction(exec.name, args, { isError: result?.isError === true, value: result?.value ?? result?.content ?? null }).catch(() => null)
        if (!verdict) return
        await appendSignal('action:verified', { tool: exec.name, carriedOut: verdict.carriedOut, failed: verdict.failed, isError: result?.isError === true })
        if (verdict.failed) await appendSignal('notice:candidate', unverifiedNotice(exec.name, what, verdict.carriedOut, new Date().toISOString()))
      })()
    }),
  )
}
