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

import { getSundialConfigPath } from '@sundial/helpers/config.js'
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
  // UC1: one `commitment:heard` to Gnomon's own ledger. Owner-turn-only: a
  // promise is the owner's to state, never a job's to invent.
  gnomon_track_promise: { kind: 'internal', tool: 'track_promise', ownerTurnOnly: true },
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
  // lane E (#12): the night shift's two tools (registered by sundial-proactive,
  // and only while `jobs.enabled`). One event each to Gnomon's own log; the job
  // itself runs in its own worktree where every permission waits for the owner.
  gnomon_night_job: { kind: 'internal', tool: 'night_job', ownerTurnOnly: true },
  gnomon_night_job_stop: { kind: 'internal', tool: 'night_job_stop', ownerTurnOnly: true },
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
  // UC1: a reminder in the owner's own Reminders is the same kind of write.
  gnomon_reminder_create: { kind: 'outward', tool: 'reminder_create' },
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
 * The `action:performed` payload for one call: its fact, never its arguments.
 *
 * `action` is the bare tool name as the SERVER knows it, which is what the
 * Reach card's rows are keyed by — `mcp__obsidian__get_vault_file` is this
 * client's name for it and `get_vault_file` is the thing that ran. And
 * `gnomon_call` is a door, not a tool: the row names the deferred tool that
 * went through it (`inner`), or every deferred call reads as one tool.
 *
 * W6 D6: `callId` is dsh's id for the call. Without it, the model calling one
 * tool several times in one step (seven `gnomon_entity_history` lookups) wrote
 * rows nobody could tell apart — 214 of the record's 1,085 rows repeated
 * another's payload within a second, which read as a double append. It is not
 * one (one gate row per `run_shell` detail row); the id makes that checkable.
 */
export function callRecord(exec, outcome, reason = null) {
  const toolName = exec.name
  const mcp = parseMcpToolName(toolName)
  const inner = toolName === 'gnomon_call' ? String((exec.args ?? exec.arguments)?.name ?? '') || null : null
  return {
    tool: toolName,
    server: mcp?.server ?? null,
    action: inner ?? mcp?.tool ?? toolName,
    ...(inner === null ? {} : { inner }),
    ...(typeof exec.callId === 'string' && exec.callId !== '' ? { callId: exec.callId } : {}),
    outcome,
    ...(reason === null ? {} : { reason }),
  }
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
function underAutonomy(decision, autonomy, toolName, gnomon, preset, ownerTurn) {
  if (autonomy === 'act' || autonomy === undefined || decision.kind !== 'allow') return decision;
  const acts = gnomon === undefined ? toolName === 'bash' : gnomon.kind === 'outward' || gnomon.shell === true;
  if (!acts) return decision;
  // W5 step 10: auto mode is Act, but actions have not earned acting alone (or the owner has not said yes).
  // The earned level governs only what Gnomon starts unasked. A turn the owner opened, or a thread
  // whose preset the owner chose (the Ask/Auto chip), has the owner's yes already: the preset
  // decides, as it did before W5.
  if (autonomy === 'earning' && (ownerTurn === true || PRESET_POLICY.outward[preset] !== undefined)) return decision;
  if (autonomy === 'earning') return { kind: 'ask', reason: `Gnomon: ${toolName} stops for your nod until actions have earned acting alone — see Settings → What Gnomon may do alone.` };
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
function underTurn(decision, ownerTurn, toolName, facts, gnomon) {
  if (ownerTurn !== false || decision.kind === 'deny') return decision
  if (facts.saidByOwner) {
    return { kind: 'deny', reason: "Gnomon: saidBy 'owner' needs a turn the owner opened, and a notice opened this one. Record it with saidBy 'me', or ask them." }
  }
  if (gnomon?.ownerTurnOnly === true && decision.kind === 'allow') {
    return { kind: 'ask', reason: `Gnomon: a notice opened this turn, not you, so ${toolName} stops for your nod.` }
  }
  return decision
}

/**
 * W3: what a verdict needs from a call's arguments and its server — never the
 * arguments themselves. This is the part of the gate's inputs `action:decided`
 * logs, so a verdict can be refolded from the log (`decideAction({ toolName,
 * ...inputs })`) without the log holding what the model wrote.
 */
export function callFacts({ toolName, args, integrations = [], isIntegrationRead }) {
  const mcp = parseMcpToolName(toolName)
  const integration = mcp === null ? undefined : integrations.find((i) => i.name === mcp.server)
  const shell = toolName === 'bash' || GNOMON_TOOLS[toolName]?.shell === true
  return {
    destructive: shell ? (destructiveDeny(args)?.reason ?? null) : null,
    saidByOwner: toolName === 'gnomon_assert' && String(args?.saidBy ?? '').trim().toLowerCase() === 'owner',
    integration: mcp === null ? null : integration === undefined ? 'unmounted' : typeof isIntegrationRead === 'function' && isIntegrationRead(integration, mcp.tool) ? 'read' : 'write',
  }
}

/** W3: the `action:decided` payload: which call, the verdict, and the gate's inputs (never the arguments). */
export function decisionRecord(exec, inputs, decision) {
  const { outcome: _none, ...call } = callRecord(exec, null)
  return { ...call, verdict: decision.kind, reason: decision.reason ?? null, inputs }
}

export function decideAction({ toolName, args, preset, approvalOverride, actions, resolveActionPolicy, integrations = [], isIntegrationRead, autonomy, ownerTurn, facts = callFacts({ toolName, args, integrations, isIntegrationRead }) }) {
  // --- the owner's own services, over MCP -----------------------------------
  // An integration tool is Gnomon's reach and takes Gnomon's verdict. A READ
  // (declared per integration) is allowed at every preset, the way any read is;
  // everything else is an outward WRITE and rides the outward ladder — denied
  // under read-only, asked under workspace-write, allowed under full access. A
  // tool from a server Gnomon did not mount is not Gnomon's to govern.
  const decided = decide();
  return underTurn(underAutonomy(decided, autonomy, toolName, GNOMON_TOOLS[toolName], preset, ownerTurn), ownerTurn, toolName, facts, GNOMON_TOOLS[toolName]);

  function decide() {
  const mcp = parseMcpToolName(toolName)
  if (mcp !== null) {
    if (facts.integration !== 'write') return { kind: 'allow' }
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
    if (toolName === 'bash' && facts.destructive !== null) return { kind: 'deny', reason: facts.destructive }
    return { kind: 'allow' }
  }

  // --- gnomon's own tools ---------------------------------------------------
  // A shell tool refuses destructive commands first, regardless of preset.
  if (gnomon.shell === true && facts.destructive !== null) return { kind: 'deny', reason: facts.destructive }

  // The preset is primary; config.actions can only tighten.
  const fromPreset = presetPolicy(gnomon.kind, preset, approvalOverride)
  const override = resolveActionPolicy(actions, gnomon.kind, gnomon.tool)
  const policy = stricter(fromPreset, override)

  if (policy === 'off') {
    const reason =
      override === 'off' && fromPreset !== 'off'
        ? `Gnomon: '${gnomon.tool}' is turned off in config.actions (${gnomon.kind}.${gnomon.tool}). Enable it in ${getSundialConfigPath()}.`
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

// A shell command that changes something: a write verb, or output sent into a
// file. `2>&1` and `> /dev/null` are not writes. A read (ls, git log, grep, a
// loop of them) is not worth a "may not have worked": on the record all 15
// such notices about a shell command in 14 days were reads.
const SHELL_WRITE = /(?:^|[\s|;&(`])((?:rm|mv|cp|mkdir|rmdir|touch|ln|tee|chmod|chown|kill|pkill|killall|open|osascript|launchctl|brew|say|defaults\s+(?:write|delete)|sed\s+-i|(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|publish|run|exec|build)|curl\b[^|;&]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data\S*|-d|-F|-T)|git\s+(?:commit|push|pull|merge|rebase|reset|checkout|switch|restore|tag|stash|clone|am|apply|cherry-pick|revert|add|rm|mv|init|fetch|worktree\s+(?:add|remove)|branch\s+-[dDmM]))(?=$|[\s|;&)`]))|(?<![0-9&>=-])>>?(?![&=])\s*(?!\/dev\/null)[^\s&|;]/
// An integration tool named as a read, when the owner's config does not say.
const READ_VERB = /^(get|list|search|show|read|fetch|find|query|lookup|describe|count|view)(_|$)/i

/**
 * Commands known to only read. A command is a read only when every part of it
 * starts with one of these; anything else (`gh pr create`, `ssh`, `rsync`,
 * `make deploy`, `python3 x.py`) is checked, because a failed outward act the
 * owner never hears about is the case this exists for. Shell syntax words and
 * `VAR=x` prefixes are skipped.
 */
const SHELL_READS = new Set(['ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'which', 'type', 'date', 'stat', 'file', 'du', 'df', 'tree', 'jq', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'less', 'more', 'diff', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'sleep', 'find', 'obsidian', 'cd', 'git'])
const SHELL_SYNTAX = new Set(['for', 'in', 'do', 'done', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', '{', '}', '!', 'time'])
const GIT_READS = new Set(['log', 'status', 'branch', 'rev-parse', 'diff', 'show', 'remote', 'config', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'cat-file', 'worktree', 'rev-list', 'for-each-ref', 'tag', 'stash'])

/** The verb that makes a shell command a write (`git push`, `>`, `gh`), or null for a read. */
export function shellWrite(command) {
  if (typeof command !== 'string') return null
  const m = SHELL_WRITE.exec(command)
  if (m !== null) return (m[1] ?? '>').replace(/\s+/g, ' ')
  // Quoted text is an argument, not a command; `2>&1` is a redirect, not a background `&`.
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ARG ').replace(/\d*>&\d+|&>/g, ' ')
  for (const part of bare.split(/\|\||&&|[|;&\n`]|\$\(|\)/)) {
    const words = part.trim().split(/\s+/).filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    const i = words.findIndex((w) => !SHELL_SYNTAX.has(w))
    if (i < 0) continue
    const [head, sub] = [words[i], words[i + 1]]
    // `for x in a b c; do` — the loop's own words are not commands.
    if (words[0] === 'for' || words[0] === 'case') continue
    // sqlite3 reads unless the statement writes.
    if (head === 'sqlite3' && !/\b(insert|update|delete|drop|create|alter|replace|vacuum|attach|reindex)\b/i.test(command)) continue
    if (!SHELL_READS.has(head)) return head
    if (head === 'git' && sub !== undefined && !sub.startsWith('-') && !GIT_READS.has(sub)) return `git ${sub}`
    if (head === 'find' && words.some((w) => w === '-delete' || w === '-exec' || w === '-execdir')) return 'find'
  }
  return null
}

/**
 * J4.2 — whether a call is one whose failure is worth telling the owner:
 * outward or irreversible. Gnomon's own memory writes are not (the model sees
 * its own result, and nothing left the machine); a read never is. `isRead`
 * answers for a mounted integration; an unknown one is read by its verb.
 * Returns the words for what was done, or null.
 */
export function outwardCall(toolName, args, isRead = () => undefined) {
  const command = typeof args?.command === 'string' ? args.command : null
  if (toolName === 'bash' || GNOMON_TOOLS[toolName]?.shell === true) {
    const verb = shellWrite(command)
    return verb === null ? null : `The command Gnomon ran (${verb === '>' ? 'writing to a file' : verb})`
  }
  const mcp = parseMcpToolName(toolName)
  if (mcp !== null) {
    const read = isRead(mcp.server, mcp.tool)
    if (read === true || (read === undefined && READ_VERB.test(mcp.tool))) return null
    return `Gnomon's call to ${mcp.server} (${mcp.tool.replace(/_/g, ' ')})`
  }
  return OUTWARD_WORDS[toolName] ?? null
}
const OUTWARD_WORDS = {
  gnomon_calendar_create: 'The calendar event Gnomon made',
  gnomon_reminder_create: 'The reminder Gnomon made',
  web_act: 'What Gnomon did on a web page',
}

/**
 * J4.2 — the notice a failed verification raises: one per tool, priced by the
 * gate like everything else. Only for an outward call (`outwardCall`), and in
 * words: never the call's arguments, which can hold the owner's own answer.
 */
export function unverifiedNotice(toolName, what, carriedOut, ts) {
  return {
    timestamp: ts,
    shape: 'self-report',
    kind: 'action-unverified',
    key: `action-unverified:${toolName}`,
    surprise: 1.5,
    precision: 0.7,
    valueHalfLifeMs: 6 * 60 * 60 * 1000,
    observation: `${what} may not have worked: its result does not show that it happened.`,
    evidence: [`tool ${toolName}`, `carried_out ${carriedOut.toFixed(2)}`],
    concerns: [],
  }
}
