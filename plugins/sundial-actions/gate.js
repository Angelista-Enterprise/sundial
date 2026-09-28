// The action gate: one pure decision per tool call.
//
// This is the safety-critical core, kept free of Cordis and IO so it can be
// tested exhaustively. `index.js` wires its verdict into dsh's
// `tools/pre-execute` waterfall (allow | deny | ask); everything policy-shaped
// lives here.
//
// THE PERMISSION PRESET IS THE SINGLE SOURCE OF TRUTH.
//
// dsh already ships one product-level control — the "Permissions" preset in the
// web UI chip — that bundles a sandbox mode (read-only | workspace-write |
// danger-full-access) with an approval policy (ask | never). It governs dsh's
// own built-ins (bash, write, edit, web_fetch, …) through dsh's native sandbox
// and approval pipeline. Gnomon used to run a SECOND, parallel permission
// language (config.actions off/ask/auto) that ALSO re-governed those same dsh
// built-ins. That duplication is gone: gnomon now speaks dsh's language.
//
// This gate governs TWO things:
//
//   1. dsh's built-in tools (bash, write, edit, web_fetch, read, …): ALLOWED
//      here — gnomon no longer gates them; dsh's own sandbox + approval, driven
//      by the SAME preset, governs them. The ONE exception is `bash`: gnomon
//      adds the destructive-command refusal (see destructive.js) that dsh's
//      bash lacks, denying `rm -rf ~` and friends regardless of preset.
//
//   2. Gnomon's OWN tools (gnomon_claim / gnomon_assert / gnomon_propose /
//      gnomon_record_outcome — internal writes — and gnomon_run_shell): mapped
//      from the preset per the table below. gnomon_run_shell additionally runs
//      the destructive-command check and denies destructive commands regardless
//      of preset.
//
// preset               | gnomon internal writes | gnomon_run_shell
// ---------------------|------------------------|-------------------------------
// read-only            | DENY                   | DENY
// workspace-write      | ALLOW                  | ASK  + destructive-block
// danger-full-access   | ALLOW                  | ALLOW + destructive-block
// custom / unknown     | approval: never→ALLOW, | ask (never→allow)
//                      | else ASK               | + destructive-block
//
// config.actions is DEMOTED to an optional per-capability OVERRIDE that can only
// TIGHTEN the preset-derived decision, never loosen it (off < ask < auto). It
// governs ONLY gnomon's own tools; it no longer touches dsh's built-ins.

import { classifyCommand } from './destructive.js'

/**
 * Gnomon's OWN tools, each mapped to the `config.actions` (kind, tool)
 * coordinate its optional tightening override reads. A tool NOT listed here is
 * a dsh built-in gnomon no longer governs (dsh's own sandbox + approval govern
 * it) — with the single `bash` destructive-check exception handled in
 * `decideAction`. `shell: true` marks a tool that must additionally pass the
 * destructive-command check regardless of preset.
 */
export const GNOMON_TOOLS = {
  gnomon_claim: { kind: 'internal', tool: 'claim' },
  gnomon_assert: { kind: 'internal', tool: 'assert' },
  gnomon_propose: { kind: 'internal', tool: 'propose' },
  // J4.3: a draft is a record on Today; the SEND is the owner's tap in their own mail client.
  gnomon_draft: { kind: 'internal', tool: 'draft' },
  gnomon_record_outcome: { kind: 'internal', tool: 'record_outcome' },
  // Scheduling is an INTERNAL write despite feeling like an action: it appends
  // one event to Gnomon's own log and touches nothing outside it. What happens
  // when the wake-up comes due is a notice, which the gate for SPEAKING already
  // governs separately — so treating this as outward would price the same
  // interruption twice.
  gnomon_schedule_wakeup: { kind: 'internal', tool: 'schedule_wakeup', ownerTurnOnly: true },
  gnomon_cancel_wakeup: { kind: 'internal', tool: 'cancel_wakeup' },
  // Asking the owner a question is internal for the same reason: it writes one
  // event to Gnomon's own record. Nothing leaves the machine, and the decision
  // about whether the question is worth the owner's attention belongs to the
  // noticing gate, which prices interruptions, not to this one, which prices
  // writes.
  gnomon_ask_owner: { kind: 'internal', tool: 'ask_owner' },
  gnomon_owner_answer: { kind: 'internal', tool: 'owner_answer', ownerTurnOnly: true },
  // Handing Gnomon a job appends one event; the job itself runs read-only in
  // a child with approvals pinned off, so the write here is the whole risk.
  gnomon_start_job: { kind: 'internal', tool: 'start_job', ownerTurnOnly: true },
  gnomon_stop_repeat: { kind: 'internal', tool: 'stop_repeat', ownerTurnOnly: true },
  // Gnomon's own rules: one event each to its own log. Owner-turn-only, because
  // a rule it adopts speaks on its own for as long as it is kept.
  gnomon_adopt_rule: { kind: 'internal', tool: 'adopt_rule', ownerTurnOnly: true },
  gnomon_drop_rule: { kind: 'internal', tool: 'drop_rule', ownerTurnOnly: true },
  gnomon_run_shell: { kind: 'outward', tool: 'run_shell', shell: true },
  // Writing to the owner's calendar changes something outside this machine's
  // record — the first outward tool that is not a shell. It asks under
  // workspace-write like run_shell does, and has no destructive-command check
  // because there is no command: the arguments ARE the event.
  gnomon_calendar_create: { kind: 'outward', tool: 'calendar_create' },
  // Acting on a web page (Phase 5) changes something outside this machine —
  // a form sent, a button pressed on someone's site. Outward: under
  // workspace-write the owner approves every act; a background job, whose
  // approval is pinned to never, cannot run it. Reading a page (web_page) is
  // not listed, like web_fetch.
  web_act: { kind: 'outward', tool: 'web_act' },
}

/**
 * The dsh sandbox mode names, as they arrive from `effectivePermissionPreset`,
 * mapped PER KIND.
 *
 * The two ladders differ at exactly one rung, and that rung is the whole point
 * of the internal/outward split. `workspace-write` says writes to the owner's
 * working world are fine; Gnomon's own append-only log is the most
 * workspace-like thing it touches, so an internal write goes through, while an
 * outward one — a command, something that changes the world beyond this
 * record — still stops for approval.
 *
 * Before this, `kind` only selected the `config.actions` override coordinate
 * and never reached the preset decision, so both ladders were the outward one.
 * The visible cost: Gnomon had to ask the owner's permission in order to ask
 * the owner a question, which made `gnomon_ask_owner` unusable from any surface
 * that cannot draw an approval prompt. The comments beside GNOMON_TOOLS already
 * argued for this behaviour; the code just never did it.
 *
 * `read-only` still means read only. An internal write is a write.
 */
const PRESET_POLICY = {
  internal: {
    'read-only': 'off',
    'workspace-write': 'auto',
    'danger-full-access': 'auto',
  },
  outward: {
    'read-only': 'off',
    'workspace-write': 'ask',
    'danger-full-access': 'auto',
  },
}

/** Permissiveness ordering. Lower = stricter. `stricter()` takes the min. */
const POLICY_RANK = { off: 0, ask: 1, auto: 2 }

/** The more restrictive of two action policies — the safe composition direction. */
function stricter(a, b) {
  return POLICY_RANK[a] <= POLICY_RANK[b] ? a : b
}

/**
 * Map the active preset to the policy one of gnomon's tools takes.
 *
 * A recognised preset maps through its kind's ladder. Anything else — a
 * `custom` preset, an unknown name, or no preset recorded yet — falls back to
 * the session's approval policy: 'never' means "no prompts" so allow (auto),
 * otherwise ask. The fallback stays kind-blind on purpose: an unrecognised
 * preset is a preset nobody has reasoned about, and the conservative rung is
 * the right one to land on.
 *
 * @param kind 'internal' | 'outward' — from GNOMON_TOOLS
 * @param preset the preset name from `effectivePermissionPreset`, or undefined
 * @param approvalOverride the session's approval override ('ask'|'never'|undefined)
 * @returns 'off' | 'ask' | 'auto'
 */
function presetPolicy(kind, preset, approvalOverride) {
  const mapped = PRESET_POLICY[kind]?.[preset]
  if (mapped !== undefined) return mapped
  // 'never' is how dsh runs a child — a job, a subagent — where nobody can
  // answer a prompt. It used to read as "allow", so a job opened by an
  // untrusted calendar title could write to the owner's services unasked. An
  // outward write there is refused; the child's own internal writes (shelve,
  // work_done) still go, since without them a job cannot report back.
  if (approvalOverride === 'never') return kind === 'internal' ? 'auto' : 'off'
  return 'ask'
}

/** The `command` string of a bash / run_shell call, or '' when absent. */
function commandOf(args) {
  if (args !== null && typeof args === 'object' && typeof args.command === 'string') return args.command
  return ''
}

/** A destructive-command deny, shared by `bash` and `gnomon_run_shell`. */
function destructiveDeny(args) {
  const verdict = classifyCommand(commandOf(args))
  if (!verdict.destructive) return null
  return {
    kind: 'deny',
    reason: `Gnomon: refusing a destructive command (${verdict.reason}). This is refused regardless of the permission preset — run it yourself if you are certain.`,
  }
}

/**
 * The verdict for one tool call. Pure: preset + approval override + config +
 * tool name + args in, decision out — so gate.test.js can cover every cell of
 * the table.
 *
 * @param opts.toolName the dsh tool name about to run
 * @param opts.args the parsed arguments
 * @param opts.preset the active permission preset name, or undefined
 * @param opts.approvalOverride the session approval override ('ask'|'never'|undefined), for the custom/unknown fallback
 * @param opts.actions the resolved `config.actions` (the optional tightening override)
 * @param opts.resolveActionPolicy `(actions, kind, tool) => 'off'|'ask'|'auto'` from @sundial/helpers
 * @returns { kind: 'allow' } | { kind: 'deny', reason } | { kind: 'ask', reason }
 */
/** `mcp__obsidian__search_notes` → { server: 'obsidian', tool: 'search_notes' }, or null. */
export function parseMcpToolName(toolName) {
  const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(toolName)
  return match === null ? null : { server: match[1], tool: match[2] }
}

/**
 * The owner's autonomy setting, as a floor under every verdict below.
 *
 * `act` is the only level at which Gnomon may change anything without being
 * asked in that breath. Below it, anything that reaches past this record — a
 * command, an outward write, a dsh built-in that is not a read — still RUNS
 * when the owner wants it, but stops for their nod first. Deny would be the
 * wrong verb: the owner who typed "run the tests" has already said yes to the
 * job, not to Gnomon deciding on its own that now is the time.
 */
function underAutonomy(decision, autonomy, toolName, gnomon) {
  if (autonomy === 'act' || autonomy === undefined || decision.kind !== 'allow') return decision;
  const acts = gnomon === undefined ? toolName === 'bash' : gnomon.kind === 'outward' || gnomon.shell === true;
  if (!acts) return decision;
  return { kind: 'ask', reason: `Gnomon: auto mode is "${autonomy}", so ${toolName} stops for your nod. Set auto mode to Act in Settings to let it run on its own.` };
}

/**
 * Whether the owner opened the turn a tool call runs in (S10).
 *
 * A notice wakes the companion with a turn the owner never typed, and a
 * notice carries text from outside: a calendar title, OCR, a mail subject. So
 * "the owner said it" is only true when the latest ORDINARY message in the
 * session is the owner's own (`source.kind === 'user'`). Context blocks — the
 * notice itself, the place caption, "Brought in" — carry a `form` and are
 * skipped: they ride along with a turn, they do not open one.
 *
 * @param events a dsh session's events in log order
 * @returns true | false, or undefined when the log holds no ordinary message
 */
export function openedByOwner(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.form !== undefined) continue
    return source?.kind === 'user'
  }
  return undefined
}

/**
 * In a turn the owner did not open, Gnomon may not speak for the owner, and
 * the writes that outlive the turn — a job, a wake-up, an answer filed as
 * theirs — stop for a nod. `ownerTurn === undefined` (no session, a direct
 * call) changes nothing.
 */
function underTurn(decision, ownerTurn, toolName, args, gnomon) {
  if (ownerTurn !== false || decision.kind === 'deny') return decision
  if (toolName === 'gnomon_assert' && String(args?.saidBy ?? '').trim().toLowerCase() === 'owner') {
    return { kind: 'deny', reason: "Gnomon: saidBy 'owner' needs a turn the owner opened, and a notice opened this one. Record it with saidBy 'me', or ask them." }
  }
  if (gnomon?.ownerTurnOnly === true && decision.kind === 'allow') {
    return { kind: 'ask', reason: `Gnomon: a notice opened this turn, not you, so ${toolName} stops for your nod.` }
  }
  return decision
}

export function decideAction({ toolName, args, preset, approvalOverride, actions, resolveActionPolicy, integrations = [], isIntegrationRead, autonomy, ownerTurn }) {
  // --- the owner's own services, over MCP -----------------------------------
  // An integration tool is Gnomon's reach and takes Gnomon's verdict. A READ
  // (declared per integration) is allowed at every preset, the way any read is;
  // everything else is an outward WRITE and rides the outward ladder — denied
  // under read-only, asked under workspace-write, allowed under full access. A
  // tool from a server Gnomon did not mount is not Gnomon's to govern.
  const decided = decide();
  return underTurn(underAutonomy(decided, autonomy, toolName, GNOMON_TOOLS[toolName]), ownerTurn, toolName, args, GNOMON_TOOLS[toolName]);

  function decide() {
  const mcp = parseMcpToolName(toolName)
  if (mcp !== null) {
    const integration = integrations.find((i) => i.name === mcp.server)
    if (integration === undefined) return { kind: 'allow' }
    if (typeof isIntegrationRead === 'function' && isIntegrationRead(integration, mcp.tool)) return { kind: 'allow' }
    const policy = presetPolicy('outward', preset, approvalOverride)
    if (policy === 'off') return { kind: 'deny', reason: `Gnomon: the '${preset ?? 'current'}' permission preset does not allow ${mcp.server} to ${mcp.tool} (it would change something outside this machine).` }
    if (policy === 'ask') return { kind: 'ask', reason: `Gnomon: ${mcp.server} → ${mcp.tool} runs behind your approval (the '${preset ?? 'current'}' preset asks before anything reaches your services).` }
    return { kind: 'allow' }
  }

  const gnomon = GNOMON_TOOLS[toolName]

  // --- dsh built-in tools ---------------------------------------------------
  // Not one of gnomon's own tools → gnomon does not gate it; dsh's native
  // sandbox + approval (driven by the same preset) do. The one exception is
  // `bash`, to which gnomon adds its destructive-command refusal.
  if (gnomon === undefined) {
    if (toolName === 'bash') {
      const deny = destructiveDeny(args)
      if (deny !== null) return deny
    }
    return { kind: 'allow' }
  }

  // --- gnomon's own tools ---------------------------------------------------
  // A shell tool refuses destructive commands first, regardless of preset.
  if (gnomon.shell === true) {
    const deny = destructiveDeny(args)
    if (deny !== null) return deny
  }

  // The preset is primary; config.actions can only tighten.
  const fromPreset = presetPolicy(gnomon.kind, preset, approvalOverride)
  const override = resolveActionPolicy(actions, gnomon.kind, gnomon.tool)
  const policy = stricter(fromPreset, override)

  if (policy === 'off') {
    const reason =
      override === 'off' && fromPreset !== 'off'
        ? `Gnomon: '${gnomon.tool}' is turned off in config.actions (${gnomon.kind}.${gnomon.tool}). Enable it in ~/.sundial/config.json.`
        : `Gnomon: the '${preset ?? 'current'}' permission preset does not allow '${gnomon.tool}' (it would change your world). Switch the permission preset to permit it.`
    return { kind: 'deny', reason }
  }
  if (policy === 'ask') {
    const reason =
      override === 'ask' && fromPreset === 'auto'
        ? `Gnomon: '${gnomon.tool}' runs behind your approval (config.actions ${gnomon.kind}.${gnomon.tool} = ask tightens the preset).`
        : `Gnomon: '${gnomon.tool}' runs behind your approval (the '${preset ?? 'current'}' preset asks first).`
    return { kind: 'ask', reason }
  }
  return { kind: 'allow' }
  }
}

/**
 * J4.1 — the second key, applied AFTER the code decision. The judge may turn an
 * `allow` into an `ask` when it reads the call as outward or irreversible above
 * its threshold; it can never loosen a deny or an ask, and a missing answer
 * (judging off, over budget) leaves the code decision exactly as it was.
 */
export function escalate(decision, judged, toolName) {
  if (decision.kind !== 'allow' || !judged || judged.escalate !== true) return decision
  return {
    kind: 'ask',
    reason: `Gnomon: the judge reads ${toolName} as ${judged.level.replace('_', ' ')} (p ${judged.p.toFixed(2)}${judged.stakes !== null ? `, stakes ${judged.stakes}/3` : ''}), so it stops for your nod.`,
  }
}

/** Which calls the judge is asked about: gnomon's own writes, bash, and any mounted integration's tool. Reads through dsh built-ins are not. */
export function judgedAction(toolName) {
  return toolName === 'bash' || GNOMON_TOOLS[toolName] !== undefined || parseMcpToolName(toolName) !== null
}

/** J4.2 — the notice a failed verification raises: one per tool, priced by the gate like everything else. */
export function unverifiedNotice(toolName, args, carriedOut, ts) {
  const what = typeof args?.command === 'string' ? args.command.slice(0, 120) : JSON.stringify(args ?? {}).slice(0, 120)
  return {
    timestamp: ts,
    shape: 'self-report',
    kind: 'action-unverified',
    key: `action-unverified:${toolName}`,
    surprise: 1.5,
    precision: 0.7,
    valueHalfLifeMs: 6 * 60 * 60 * 1000,
    observation: `${toolName} may not have done what was asked (the judge put "carried out" at ${carriedOut.toFixed(2)}): ${what}`,
    evidence: [`tool ${toolName}`, `carried_out ${carriedOut.toFixed(2)}`],
    concerns: [],
  }
}
