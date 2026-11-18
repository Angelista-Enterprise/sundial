// The action gate: one pure decision per tool call.
//
// This is the safety-critical core, kept free of Cordis and IO so it can be
// tested exhaustively. `index.js` wires its verdict into dsh's
// `tools/pre-execute` waterfall (allow | deny | ask); everything policy-shaped
// lives here.
//
// THE PERMISSION PRESET IS THE SINGLE SOURCE OF TRUTH.
//
// dsh already ships one product-level control, the "Permissions" preset in the
// web UI chip, that bundles a sandbox mode (read-only | workspace-write |
// danger-full-access) with an approval policy (ask | never). It governs dsh's
// own built-ins (bash, write, edit, web_fetch, …) through dsh's native sandbox
// and approval pipeline. Gnomon used to run a SECOND, parallel permission
// language (config.actions off/ask/auto) that ALSO re-governed those same dsh
// built-ins. That duplication is gone: gnomon now speaks dsh's language.
//
// This gate governs TWO things:
//
//   1. dsh's built-in tools (bash, write, edit, web_fetch, read, …): ALLOWED
//      here: gnomon no longer gates them; dsh's own sandbox + approval, driven
//      by the SAME preset, governs them. The ONE exception is `bash`: gnomon
//      adds the destructive-command refusal (see destructive.js) that dsh's
//      bash lacks, denying `rm -rf ~` and friends regardless of preset.
//
//   2. Gnomon's OWN tools (gnomon_claim / gnomon_assert / gnomon_propose /
//      gnomon_record_outcome, the internal writes, and gnomon_run_shell): mapped
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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSundialConfigPath } from '@sundial/helpers/config.js'
import { DEFAULT_KNOWN_HOSTS } from '@sundial/helpers/web-config.js'
import { classifyCommand } from './destructive.js'
import { recordOf, touchesOwnSecrets, waitsBySleeping } from './run-shell.js'
import { askFirst, blindTypingOf, EFFECT, finalOf, privateApp, privateData, privateOf, stepList, unknownPress } from './gate-finals.js'
import { commandOf, freePath, inlineAddress, pathsOf, quote, readParts, shellWrite, touchesOf } from './gate-shell.js'
import { GNOMON_TOOLS } from './gate-tools.js'

// The gate's parts, re-exported: callers and tests import the gate from here.
export { BROWSERS, blindTypingOf, enterApp, finalAsk, finalOf, finalWord, judgedPlans, keyboardLook, MAIL_APPS, mailLine, mailOf, oneOf, privateApp, privateOf, recipientsOf, stepList } from './gate-finals.js'
export { commandLine, SHELL_SYNTAX, shellWords, shellWrite, touchesLine, touchesOf } from './gate-shell.js'
export { GNOMON_TOOLS } from './gate-tools.js'

// 2026-11-15: a rig chat said "remember: X" and gnomon_assert filed 99 made-up facts as the owner's. In a rig session
// every tool that writes the owner's record is refused: Gnomon's internal writes, a notice verdict, the shelf, the board,
// and the owner's own calendar and reminders (private apps).
export const RIG_FENCED = new Set([...Object.keys(GNOMON_TOOLS).filter((t) => GNOMON_TOOLS[t].kind === 'internal'), 'gnomon_notice_feedback', 'gnomon_shelve', 'gnomon_work_done', 'gnomon_board', 'gnomon_calendar_create', 'gnomon_reminder_create'])
// S4: the daily features the rig must be able to test. In a rig chat with a live sandbox these run: their rows carry the
// chat's sessionId and fold into its sandbox only (@sundial/helpers/sandbox.js), so the owner's record cannot tell.
// Everything else in RIG_FENCED stays refused there: a fact or a claim, an outcome, a proposal, the shelf, the board, a
// night job, a reach, the calendar and the reminders.
export const SANDBOXED = new Set(['gnomon_schedule_wakeup', 'gnomon_cancel_wakeup', 'gnomon_track_promise', 'gnomon_draft', 'gnomon_start_job', 'gnomon_stop_repeat', 'gnomon_adopt_rule', 'gnomon_pause_rule', 'gnomon_resume_rule', 'gnomon_drop_rule', 'gnomon_ask_owner', 'gnomon_owner_answer'])
export const RIG_NO_MEMORY = "This is a test chat; nothing is saved to the owner's record. Carry on without it."
const RIG_NO_QUESTION = "This is a test chat; a question is not put on the owner's record. Ask in this chat (ask_user_question), or carry on without it."
const RIG_NO_RECORD = "This is a test chat; a shell command that names Sundial's data folder, its database, its MCP server or its token is refused. Carry on without it."
/** Set 4 R1: a shell command whose inline script holds an address (gate-shell.js inlineAddress), refused in every preset and mode. */
export const INLINE_ADDRESS = 'Gnomon: refused, an inline python or node script with a web or app address in it. To read a page, use web_fetch, or write the file with cat and open a plain URL.'
const NO_DB_WRITE = "Gnomon: refused, a shell command that opens Sundial's own database other than read-only. The record is written only through Gnomon's tools; read it with the gnomon_* read tools or sqlite3 -readonly."
/** Run 175: the kind of the last final refused in `session` since `turnAt` (ms, the turn's start), else null. */
export const refusedFinal = (state, session, turnAt) =>
  (session && turnAt ? state?.approvals?.recent?.findLast((a) => a.sessionId === session && a.kind !== 'plain' && a.answer === 'rejected' && a.by !== 'timeout' && a.by !== 'asker' && Date.parse(a.answeredAt) >= turnAt)?.kind : null) ?? null
/** The same act under another kind: discard and delete are one, and a final-unknown may be any of them. */
const sameFinal = (a, b) => (a === 'discard' ? 'delete' : a) === (b === 'discard' ? 'delete' : b) || a === 'final-unknown' || b === 'final-unknown'
/**
 * A rig session's write to the owner's record (a sandboxed tool only when the chat has no live sandbox), a shell write to
 * the database in any chat, or, after a no to a final in this turn, that act again: refused.
 */
function fenced(toolName, facts, rig, refused, sandbox) {
  const boxed = rig && sandbox === true && SANDBOXED.has(toolName)
  if (rig && !boxed && toolName === 'gnomon_ask_owner') return { kind: 'deny', reason: RIG_NO_QUESTION }
  if (rig && !boxed && (RIG_FENCED.has(toolName) || facts.boardPlace)) return { kind: 'deny', reason: RIG_NO_MEMORY }
  if (rig && facts.record) return { kind: 'deny', reason: RIG_NO_RECORD }
  if (facts.record === 'write') return { kind: 'deny', reason: NO_DB_WRITE }
  if (facts.inlineAddress) return { kind: 'deny', reason: INLINE_ADDRESS }
  // A question after the no is not blocked ("save it as a draft instead?"): the act itself stays refused, whatever the answer.
  if (refused && facts.final && sameFinal(facts.final.kind, refused)) return { kind: 'deny', reason: `The ${refused} was refused in this turn, and a no is final: do not try it again or ask for it again. End your answer saying it was not done.` }
  return null
}

/**
 * Why a watch rule's reach cannot be adopted, or null. A reach names the tool
 * its yes performs (`do: [{reach: {tool, brief}}]` in @sundial/kernel/watch.ts),
 * and only a tool this gate governs may be named: one of Gnomon's own above, or
 * a mounted integration's `mcp__<server>__<tool>`. A tool the gate does not know
 * would run ungoverned, so it is refused at adoption, not at the tap.
 */
export function reachRefusal(rule, integrations = []) {
  for (const action of rule?.do ?? []) {
    const tool = action?.reach?.tool
    if (typeof tool !== 'string') continue
    const mcp = parseMcpToolName(tool)
    if (GNOMON_TOOLS[tool] !== undefined || (mcp !== null && integrations.some((i) => i.name === mcp.server))) continue
    return `reach.tool ${tool} is not a tool the action gate knows: one of Gnomon's own (${Object.keys(GNOMON_TOOLS).filter((t) => GNOMON_TOOLS[t].kind === 'outward').join(', ')} …) or a mounted integration's mcp__<server>__<tool>`
  }
  return null
}

/**
 * The dsh sandbox mode names, as they arrive from `effectivePermissionPreset`,
 * mapped PER KIND.
 *
 * The two ladders differ at exactly one rung, and that rung is the whole point
 * of the internal/outward split. `workspace-write` says writes to the owner's
 * working world are fine; Gnomon's own append-only log is the most
 * workspace-like thing it touches, so an internal write goes through, while an
 * outward one (a command, something that changes the world beyond this
 * record) still stops for approval.
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

/** The more restrictive of two action policies: the safe composition direction. */
function stricter(a, b) {
  return POLICY_RANK[a] <= POLICY_RANK[b] ? a : b
}

/**
 * Map the active preset to the policy one of gnomon's tools takes.
 *
 * A recognised preset maps through its kind's ladder. Anything else (a
 * `custom` preset, an unknown name, or no preset recorded yet) falls back to
 * the session's approval policy: 'never' means "no prompts" so allow (auto),
 * otherwise ask. The fallback stays kind-blind on purpose: an unrecognised
 * preset is a preset nobody has reasoned about, and the conservative rung is
 * the right one to land on.
 *
 * @param kind 'internal' | 'outward', from GNOMON_TOOLS
 * @param preset the preset name from `effectivePermissionPreset`, or undefined
 * @param approvalOverride the session's approval override ('ask'|'never'|undefined)
 * @returns 'off' | 'ask' | 'auto'
 */
function presetPolicy(kind, preset, approvalOverride) {
  const mapped = PRESET_POLICY[kind]?.[preset]
  if (mapped !== undefined) return mapped
  // 'never' is how dsh runs a child (a job, a subagent) where nobody can
  // answer a prompt. It used to read as "allow", so a job opened by an
  // untrusted calendar title could write to the owner's services unasked. An
  // outward write there is refused; the child's own internal writes (shelve,
  // work_done) still go, since without them a job cannot report back.
  if (approvalOverride === 'never') return kind === 'internal' ? 'auto' : 'off'
  return 'ask'
}

/** A plain read is free only where a shell command could run anyway: read-only and a job nobody can answer decide as before. */
const freeReadPreset = (preset, approvalOverride) => (preset === 'workspace-write' || preset === 'danger-full-access') && approvalOverride !== 'never'


/** A destructive-command deny, shared by `bash` and `gnomon_run_shell`. */
function destructiveDeny(args) {
  const verdict = classifyCommand(commandOf(args))
  if (!verdict.destructive) return null
  return {
    kind: 'deny',
    reason: `Gnomon: refusing a destructive command (${verdict.reason}). This is refused regardless of the permission preset. Run it yourself if you are certain.`,
  }
}

/** The facts of a final the record keeps: its kind and how it goes, never a name, an address or a command. */
const bare = (final) => final && { kind: final.kind, via: final.via, blind: final.blind, ...(final.unnamed ? { unnamed: true } : {}) }

/** Round 3: the one app every step the plan read is in, the ladder's key; null with no planned step, two apps, or a private app (never on the record). */
const oneApp = (toolName, plans) => {
  const apps = toolName === 'screen_act' && Array.isArray(plans) && plans.some((p) => p?.verb !== 'keyboard') ? plans.map((p) => (typeof p?.app === 'string' ? p.app.trim() : '')) : []
  return apps.length > 0 && apps[0] !== '' && apps.every((a) => a.toLowerCase() === apps[0].toLowerCase()) && !privateApp(apps[0]) ? apps[0] : null
}

/**
 * Round 3: how far a plain act of `tool` in `app` is up the ladder (`state.autonomy.ladder`, autonomy-track.ts): the owner's
 * yeses in a row and the k it needs (`config.actions.earnAfter`). `earned` at k: a plain act there stops asking. Null for a private app.
 */
export function rungOf(state, tool, app) {
  if (typeof app !== 'string' || app === '' || privateApp(app)) return null
  const k = state?.config?.actions?.earnAfter ?? 10
  const yes = state?.autonomy?.ladder?.find((r) => r.tool === tool && r.app.toLowerCase() === app.toLowerCase())?.yes ?? 0
  return { yes, k, app, earned: yes >= k }
}

/** A final asks first in every preset and every mode, test mode included; a blind or unnamed one is refused, and so is one nobody can be asked about. */
function underFinal(decision, final, approvalOverride) {
  if (!final || decision.kind === 'deny') return decision
  const send = final.kind === 'send'
  if (final.blind && send) return { kind: 'deny', reason: 'Gnomon: refused, a blind Send. Nothing can be seen where it lands (a private app, or keys sent by System Events), so a Send there is never pressed, and a private app sends nothing for Gnomon, by script either. Show the owner the mail (to, cc, subject, body) and let them send it, or send it from a mail app or webmail that is not private.' }
  if (final.blind) return { kind: 'deny', reason: `Gnomon: refused, a blind final step (it ${EFFECT[final.kind]}). Nothing can be seen where it lands, so it is never pressed. Ask the owner to do it.` }
  if (final.unnamed) return { kind: 'deny', reason: `Gnomon: refused, a ${send ? 'Send' : 'final step'} with no app named. Name the app on the step ({app}), so the gate can tell whether that app can be seen.` }
  if (approvalOverride === 'never') return { kind: 'deny', reason: `Gnomon: this ${EFFECT[final.kind]}, so it asks the owner first, and nobody can be asked here (approvals are off). ${send ? 'Show the owner the mail (to, cc, subject, body) and let them send it.' : 'Tell the owner what it would do and let them do it.'}` }
  return { kind: 'ask', reason: `Gnomon: this ${askFirst(final)}` }
}

/** Owner decision 2026-11-17: the line a press on a button whose words Gnomon does not know asks with, in every mode. */
export const UNKNOWN_SAY = 'Gnomon: I do not know what this button does, so I ask you every time, and a yes here never counts toward acting alone.'
/** A press on an unknown button asks in every mode, earned or not (gate-finals.js unknownPress); a refusal stays one. */
const underUnknown = (decision, unknown) => (!unknown || decision.kind === 'deny' ? decision : { kind: 'ask', reason: UNKNOWN_SAY })

/** What a private refusal tells the model to do instead (run 138: it went looking for the same content in other places). */
export const PRIVATE_SAY = 'Tell the owner it is a private app you do not open, and do not look for its content anywhere else.'
/** Opening, raising or acting in a private app is refused in every mode. The reason never names the app: a hidden app's name stays off the record. */
function underPrivate(decision, hidden) {
  if (!hidden || decision.kind === 'deny') return decision
  return { kind: 'deny', reason: `Gnomon: refused, a private app. The owner keeps it out of reach: Gnomon never opens, raises, reads or acts in it, in any mode. ${PRIVATE_SAY}` }
}

// --- egress: a call that carries what Gnomon read in private off the Mac (Set 3 R3) ---
/** The data shapes a query or an address can carry, per id: the words for it and its pattern. Checked in this order. */
const SHAPES = [
  ['email', 'an email address', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ['phone', 'a phone number', /\+\d[\d ().-]{6,}\d|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/],
  ['alias', "a person's alias", /\bperson-[0-9a-f]{6,}\b/i],
  ['iban', 'an account number', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/],
  ['home', 'a path in the home folder', /\/Users\/[^/\s]+|~\//],
  ['digits', 'a long run of digits', /\d{6,}|\b\d{3,4}(?:[ -]\d{3,4}){2,}\b/],
  ['token', 'a token', /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}\b/],
]
const READ_SHAPE = 'a word from the private read'
/** Hosts a call may reach after a private read without asking, when it carries no data shape. config.json `web.knownHosts` (resolved by helpers web-config.ts) replaces the list. */
export const KNOWN_HOSTS = DEFAULT_KNOWN_HOSTS
/** The known hosts of the resolved config (`loadSundialConfig().web`), else the default list. */
export const knownHostsOf = (config) => (Array.isArray(config?.web?.knownHosts) ? config.web.knownHosts : KNOWN_HOSTS)
/** What each kind of private read is, as an ask names it. */
const READ_WORDS = { file: 'a file outside the workspace', screen: "the screen's text", integration: "a connected service's data", record: "the owner's record" }
/** How each kind of egress goes, as an ask names it. */
const VIA_WORDS = { search: 'web search', fetch: 'web fetch', open: 'page opened in a browser', act: 'web act', shell: 'shell command' }
/**
 * The system dictionary (/usr/share/dict/words), its lower-case entries only (a proper noun stays distinctive), read once when first
 * asked: a word in it is common and never counts as a name. A read-only memo of a file on disk, not kernel state: it holds no fact.
 */
const DICT = { words: null }
const dictionary = () => (DICT.words ??= (() => { try { return new Set(readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => w !== '' && w === w.toLowerCase())) } catch { return new Set() } })())
/** The calendar's names: capitalised in the dictionary, so they would read as names, and in every other text. */
const CALENDAR = new Set('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december'.split(' '))
const common = (w, dict) => CALENDAR.has(w) || [w, ...['s', 'es', 'ed', 'ing', 'ly'].map((end) => (w.endsWith(end) ? w.slice(0, -end.length) : w))].some((x) => dict.has(x))
/**
 * The distinctive words of what a private read returned, lower case, at most 40: a capitalised name-like word, or a word of 8
 * letters or more, that is not in the dictionary (so a common word never counts). Compared in memory for one decision, never kept.
 * None when there is no dictionary to tell a common word from a name.
 */
export function privateWords(texts, dict = dictionary()) {
  if (dict.size === 0) return []
  const out = new Set()
  for (const text of texts) {
    for (const [w] of String(text ?? '').slice(0, 20_000).matchAll(/\p{L}[\p{L}\p{N}]{3,}/gu)) if (!common(w.toLowerCase(), dict) && (/^\p{Lu}\p{Ll}+$/u.test(w) || w.length >= 8) && out.add(w.toLowerCase()).size >= 40) return [...out]
  }
  return [...out]
}
const wordIn = (text, words) => words.find((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'iu').test(text))
/** The shapes a text carries, `[id, words, what matched]`, the words of a private read last. */
function shapesIn(text, words) {
  const found = SHAPES.flatMap(([id, said, re]) => (re.test(text) ? [[id, said, re.exec(text)[0]]] : []))
  const word = wordIn(text, words)
  return word ? [...found, ['read', READ_SHAPE, word]] : found
}
const decoded = (raw) => { try { return decodeURIComponent(raw.replace(/\+/g, ' ')) } catch { return raw } }
/** An address as egress reads it: its host, and its path, query and fragment decoded. */
function addressOf(raw) {
  const u = URL.canParse(raw) ? new URL(raw) : null
  const tail = decoded(u ? `${u.pathname}${u.search}${u.hash}` : raw)
  return { host: u?.hostname.toLowerCase() || null, tail, text: `${u?.hostname ?? ''}${tail}` }
}
const parsedStep = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return null } }
/** A shell command that reaches another machine, and the tool it does it with. */
const NET = /(?:^|[\s|;&(`])(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync)\s/
/** The host a network shell command reaches: its first URL's, a `user@host`'s, or the first plain word after nc. */
function shellHost(command) {
  const url = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\\]+/i.exec(command)?.[0]
  if (url) return addressOf(url).host
  const at = /[\w.-]+@([\w-]+(?:\.[\w-]+)*)/.exec(command)?.[1]
  if (at) return at.toLowerCase()
  return /\b(?:nc|ncat|netcat)\s+(?:-\S+\s+)*([\w.-]+)/.exec(command)?.[1]?.toLowerCase() ?? null
}
/**
 * What a call sends off the Mac, or null: a web_search's queries; a web_fetch's or a web_page's address (`find` stays on the Mac);
 * a screen_act step's http(s) `url` (opened in a browser); the text a web_act types or chooses; a shell command that reaches another
 * machine (curl, wget, nc, ssh, scp, sftp, rsync), read whole.
 */
function webSent(toolName, args) {
  if (toolName === 'web_search') return { via: 'search', host: null, text: [args?.queries, args?.query].flat().filter((q) => typeof q === 'string').join(' · ') }
  if (toolName === 'web_fetch' || (toolName === 'web_page' && typeof args?.url === 'string')) return { via: 'fetch', ...addressOf(typeof args?.url === 'string' ? args.url.trim() : '') }
  if (toolName === 'web_act') {
    const text = [args?.text, args?.value].filter((t) => typeof t === 'string' && t.trim() !== '').join(' · ')
    return text ? { via: 'act', host: null, tail: text, text } : null
  }
  if (toolName === 'screen_act') {
    const url = [args, ...(stepList(args?.steps) ?? [])].map(parsedStep).map((s) => s?.url).find((u) => typeof u === 'string' && /^\s*https?:\/\//i.test(u))
    return url ? { via: 'open', ...addressOf(url.trim()) } : null
  }
  if (toolName !== 'bash' && GNOMON_TOOLS[toolName]?.shell !== true) return null
  const command = commandOf(args)
  return NET.test(command) ? { via: 'shell', host: shellHost(command), tail: command, text: decoded(command) } : null
}
const knownHost = (host, hosts) => typeof host === 'string' && hosts.some((k) => host === k || host.endsWith(`.${k}`))
/**
 * The egress facts of a call, never its words: how it goes, the data shapes it carries, whether its host is known (a search and a
 * web act have none to judge). `words`: the private read's own (privateWords); `hosts`: the known hosts (knownHostsOf).
 */
export function egressOf(toolName, args, { words = [], hosts = KNOWN_HOSTS } = {}) {
  const sent = webSent(toolName, args)
  return sent && { via: sent.via, shapes: shapesIn(sent.text, words).map(([id]) => id), known: sent.via === 'search' || sent.via === 'act' || knownHost(sent.host, hosts) }
}
/** The file tools that read, and the argument that names what they read. */
const FILE_READS = { read: 'file_path', read_image: 'file_path', grep: 'path', glob: 'path' }
/** Gnomon's own tools that are not reads of its record: its writes, the board and the shelf, and the tools that act or wait. */
const NOT_RECORD_READS = new Set([...Object.keys(GNOMON_TOOLS), ...RIG_FENCED, 'gnomon_call', 'gnomon_lens', 'gnomon_await', 'gnomon_skill', 'gnomon_pull_up'])
const outside = (p, cwd) => typeof p === 'string' && p !== '' && (/^[~$]/.test(p) || !`${resolve(cwd, p)}/`.startsWith(`${resolve(cwd)}/`))
/**
 * What private read a call is, or null: 'outside' (a file outside the workspace `cwd`, by a file tool or a shell command that names
 * one to read), 'integration' (a mounted service's read: `integration` is callFacts' fact) or 'record' (one of Gnomon's own read
 * tools, directly or through gnomon_call).
 */
export function readsOf(toolName, args, cwd = process.cwd(), integration = null) {
  const arg = FILE_READS[toolName]
  if (arg) return outside(args?.[arg], cwd) ? 'outside' : null
  if (integration === 'read') return 'integration'
  const tool = toolName === 'gnomon_call' ? String(parsedStep(args)?.name ?? '') : toolName
  if (tool.startsWith('gnomon_') && !NOT_RECORD_READS.has(tool)) return 'record'
  if (toolName !== 'bash' && GNOMON_TOOLS[toolName]?.shell !== true) return null
  return touchesOf(commandOf(args)).reads.some((p) => outside(p, cwd)) ? 'outside' : null
}
/**
 * The private read chat `session` holds (`state.privateReads`, folded by privateReads), else null. Its own read stays in force across
 * turns while its text can still be in the model's context: from `contextAt` (ms, the chat's newest compaction checkpoint) on (run
 * 202: a code read in one turn went out in a fetch in the next, unasked). A look no chat asked for never entered a chat's context:
 * it counts only in the turn it came in, from `turnAt` (ms, the turn's own start) on.
 */
export const chatRead = (state, session, { contextAt = 0, turnAt = null } = {}) => {
  const chats = state?.privateReads?.chats ?? {}
  const live = (read, from) => Boolean(read && READ_WORDS[read.kind] && !(from > Date.parse(read.at)))
  const own = session ? chats[session] : undefined
  return live(own, contextAt) ? own.kind : live(chats[''], turnAt) ? chats[''].kind : null
}
/** After a private read still in the chat's context, a call that carries a data shape off the Mac, or goes to a host Gnomon does not know, asks first. A plain one never does. */
function underEgress(decision, egress, readPrivate, approvalOverride) {
  if (!egress || !READ_WORDS[readPrivate] || decision.kind === 'deny' || (egress.shapes.length === 0 && egress.known)) return decision
  const what = egress.shapes.length ? `carries text shaped like private data (${egress.shapes.map((id) => SHAPES.find(([s]) => s === id)?.[1] ?? READ_SHAPE).join(', ')})` : 'goes to a site Gnomon does not know'
  const said = `this ${VIA_WORDS[egress.via] ?? 'call'} ${what} after a private read in this chat (${READ_WORDS[readPrivate]})`
  if (approvalOverride === 'never') return { kind: 'deny', reason: `Gnomon: ${said}, so it asks the owner first, and nobody can be asked here (approvals are off). Leave the private words out, or tell the owner what you would look up.` }
  return { kind: 'ask', reason: `Gnomon: ${said}. It asks you first.`, egress: true }
}
/**
 * The owner's switch for unattended runs (experiments.screenActUnasked): an always-ask tool's plain act the plan read runs without
 * its ask. A final still asks, a refusal still refuses, and so does an egress (an address opened after a private read).
 */
export const testModeRuns = (toolName, decision, testMode, facts, planned) =>
  decision.kind === 'ask' && GNOMON_TOOLS[toolName]?.alwaysAsk === true && testMode === true && facts?.final === null && decision.egress !== true && planned
/** The ask the owner reads for an egress (index.js puts it on the ask; the record keeps the gate's reason): what is sent, and to where. */
export function egressAsk(toolName, args, readPrivate, { words = [], hosts = KNOWN_HOSTS } = {}) {
  const sent = webSent(toolName, args)
  if (!sent) return null
  const [hit] = shapesIn(sent.text, words)
  const cut = (s) => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
  const host = `${sent.host ?? 'an address Gnomon cannot read'}`
  const unknown = knownHost(sent.host, hosts) ? '' : ' (a site Gnomon does not know)'
  const where = { search: 'the search engines in a web search', fetch: `${host} in a web fetch${unknown}`, open: `${host} in a browser${unknown}`, act: "a web page in Gnomon's browser", shell: `${host} from the shell${unknown}` }[sent.via]
  return `Gnomon: this sends ${quote(cut(hit ? hit[2] : sent.tail ?? sent.text))}${hit ? ` (${hit[1]})` : ''} to ${where}, after a private read in this chat (${READ_WORDS[readPrivate] ?? 'a private read'}). It asks you first.`
}

/** Typing blind is refused in every mode, test mode included. The reason never names the app: a hidden app's name stays off the record. */
function underTyping(decision, typing) {
  if (!typing || decision.kind === 'deny') return decision
  if (typing === 'unnamed') return { kind: 'deny', reason: 'Gnomon: refused, typing with no app named. Name the app on the step ({app}), so the gate can tell whether that app can be seen.' }
  return { kind: 'deny', reason: "Gnomon: refused, typing in a private app. Nothing in it can be seen, so Gnomon cannot tell where the text lands (a search field, another window). Ask the owner to type it, or for a mail use a mail app or webmail that is not private." }
}

/**
 * The verdict for one tool call. Pure: preset + approval override + config +
 * tool name + args in, decision out, so gate.test.js can cover every cell of
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
 * Reach card's rows are keyed by: `mcp__obsidian__get_vault_file` is this
 * client's name for it and `get_vault_file` is the thing that ran. And
 * `gnomon_call` is a door, not a tool: the row names the deferred tool that
 * went through it (`inner`), or every deferred call reads as one tool.
 *
 * W6 D6: `callId` is dsh's id for the call. Without it, the model calling one
 * tool several times in one step (seven `gnomon_entity_history` lookups) wrote
 * rows nobody could tell apart: 214 of the record's 1,085 rows repeated
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
 * asked in that breath. Below it, anything that reaches past this record (a
 * command, an outward write, a dsh built-in that is not a read) still RUNS
 * when the owner wants it, but stops for their nod first. Deny would be the
 * wrong verb: the owner who typed "run the tests" has already said yes to the
 * job, not to Gnomon deciding on its own that now is the time.
 */
function underAutonomy(decided, autonomy, toolName, gnomon, preset, ownerTurn, earned) {
  // Round 3: the ladder. A plain act the owner has said yes to k times in a row in this app runs without the ask (decideAction
  // decides it may); the owner's dial below still wins.
  const decision = earned ? { kind: 'allow', reason: `earned: ${earned.yes} yeses in a row in ${earned.app}`, earned: true } : decided;
  if (autonomy === 'act' || autonomy === undefined || decision.kind !== 'allow') return decision;
  const acts = gnomon === undefined ? toolName === 'bash' : gnomon.kind === 'outward' || gnomon.shell === true;
  // A plain read reaches nothing past this record.
  if (!acts || decision.reason === PLAIN_READ) return decision;
  // W5 step 10: auto mode is Act, but actions have not earned acting alone (or the owner has not said yes).
  // The earned level governs only what Gnomon starts unasked. A turn the owner opened, or a thread
  // whose preset the owner chose (the Ask/Auto chip), has the owner's yes already: the preset
  // decides, as it did before W5.
  if (autonomy === 'earning' && (ownerTurn === true || PRESET_POLICY.outward[preset] !== undefined)) return decision;
  if (autonomy === 'earning') return { kind: 'ask', reason: `Gnomon: ${toolName} stops for your nod until actions have earned acting alone: see Settings → What Gnomon may do alone.` };
  return { kind: 'ask', reason: `Gnomon: auto mode is "${autonomy}", so ${toolName} stops for your nod. Set auto mode to Act in Settings to let it run on its own.` };
}

/**
 * Whether the owner opened the turn a tool call runs in (S10).
 *
 * A notice wakes the companion with a turn the owner never typed, and a
 * notice carries text from outside: a calendar title, OCR, a mail subject. So
 * "the owner said it" is only true when the latest ORDINARY message in the
 * session is the owner's own (`source.kind === 'user'`). Context blocks (the
 * notice itself, the place caption, "Brought in") carry a `form` and are
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
    // dsh's compaction checkpoint condenses a turn; it does not open one. Read past it, or the owner's
    // own message vanishes behind it and their yes to a question stops for a second nod.
    if (source?.plugin === 'compact' || source?.kind === 'compact-checkpoint') continue
    return source?.kind === 'user'
  }
  return undefined
}

/**
 * In a turn the owner did not open, Gnomon may not speak for the owner, and
 * the writes that outlive the turn (a job, a wake-up, an answer filed as
 * theirs) stop for a nod. `ownerTurn === undefined` (no session, a direct
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
 * W3: what a verdict needs from a call's arguments and its server, never the
 * arguments themselves. This is the part of the gate's inputs `action:decided`
 * logs, so a verdict can be refolded from the log (`decideAction({ toolName,
 * ...inputs })`) without the log holding what the model wrote.
 */
export function callFacts({ toolName, args, integrations = [], isIntegrationRead, webElement, lookApp, fill, plans, cwd, words, hosts }) {
  const mcp = parseMcpToolName(toolName)
  const integration = mcp === null ? undefined : integrations.find((i) => i.name === mcp.server)
  const shell = toolName === 'bash' || GNOMON_TOOLS[toolName]?.shell === true
  const final = bare(finalOf(toolName, args, webElement, plans))
  const unknown = unknownPress(toolName, args, plans)
  const egress = egressOf(toolName, args, { words, hosts })
  const integrationFact = mcp === null ? null : integration === undefined ? 'unmounted' : typeof isIntegrationRead === 'function' && isIntegrationRead(integration, mcp.tool) ? 'read' : 'write'
  return {
    destructive: shell ? (destructiveDeny(args)?.reason ?? null) : null,
    // Set 2 R2: a shell command that only reads (plainRead) asks nothing.
    // S2 R5: what it does to Sundial's own record (recordOf): a write is refused in every chat, naming it in a rig chat.
    ...(shell ? { plainRead: plainRead(commandOf(args)), record: recordOf(commandOf(args)) } : {}),
    ...(shell && inlineAddress(commandOf(args)) ? { inlineAddress: true } : {}),
    // A lens placed writes board:place to the owner's board (fenced in a rig chat); its preview is a read.
    ...(toolName === 'gnomon_lens' ? { boardPlace: args?.action === 'place' } : {}),
    saidByOwner: toolName === 'gnomon_assert' && String(args?.saidBy ?? '').trim().toLowerCase() === 'owner',
    integration: integrationFact,
    final,
    // The record never holds a final's app (Round 1): a plain act's only. A press on a button nobody knows holds none either: it never earns (2026-11-17).
    app: final || unknown ? null : oneApp(toolName, plans),
    ...(unknown ? { unknownButton: true } : {}),
    typing: blindTypingOf(toolName, args, lookApp, fill),
    private: privateOf(toolName, args, lookApp, fill),
    // Set 3 R3: a read outside the workspace (privateReads folds it per chat), and what a web call carries off the Mac.
    ...(readsOf(toolName, args, cwd, integrationFact) ? { reads: readsOf(toolName, args, cwd, integrationFact) } : {}),
    ...(egress ? { egress } : {}),
  }
}

/** W3: the `action:decided` payload: which call, the verdict, and the gate's inputs (never the arguments). */
export function decisionRecord(exec, inputs, decision) {
  const { outcome: _none, ...call } = callRecord(exec, null)
  // Set 3 R3: the chat the call ran in, so privateReads files a private read under that chat.
  const session = exec.agent?.session?.id
  return { ...call, ...(typeof session === 'string' && session !== '' ? { sessionId: session } : {}), verdict: decision.kind, reason: decision.reason ?? null, inputs }
}

export function decideAction({ toolName, args, preset, approvalOverride, actions, resolveActionPolicy, integrations = [], isIntegrationRead, autonomy, ownerTurn, earned, rig, sandbox, refused, readPrivate, facts = callFacts({ toolName, args, integrations, isIntegrationRead }) }) {
  const fence = fenced(toolName, facts, rig, refused, sandbox)
  if (fence) return fence
  // --- the owner's own services, over MCP -----------------------------------
  // An integration tool is Gnomon's reach and takes Gnomon's verdict. A READ
  // (declared per integration) is allowed at every preset, the way any read is;
  // everything else is an outward WRITE and rides the outward ladder: denied
  // under read-only, asked under workspace-write, allowed under full access. A
  // tool from a server Gnomon did not mount is not Gnomon's to govern.
  const decided = decide();
  // Round 3: `earned` (rungOf) loosens only an ask, only for a plain act in the one app it was earned in, in a turn the owner
  // opened, and never past the owner's own "ask" (config.actions or the thread's approvals). Finals, typing and private apps tighten after.
  const gnomon = GNOMON_TOOLS[toolName]
  const climbed = earned?.earned === true && gnomon !== undefined && decided.kind !== 'deny' && facts.app && earned.app === facts.app && facts.final === null && !facts.private && facts.typing === null && ownerTurn !== false && approvalOverride !== 'ask' && resolveActionPolicy(actions, gnomon.kind, gnomon.tool) !== 'ask' ? earned : null
  const decision = underTurn(underAutonomy(decided, autonomy, toolName, gnomon, preset, ownerTurn, climbed), ownerTurn, toolName, facts, gnomon);
  const asked = gnomon?.alwaysAsk && decision.kind === 'allow' && decision.earned !== true ? { kind: 'ask', reason: `Gnomon: ${toolName} always asks: it acts in another app on your screen.` } : decision;
  return underPrivate(underTyping(underFinal(underEgress(underUnknown(asked, facts.unknownButton), facts.egress, readPrivate, approvalOverride), facts.final, approvalOverride), facts.typing), facts.private);

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
    if (toolName === 'bash' && facts.plainRead === true && freeReadPreset(preset, approvalOverride)) return { kind: 'allow', reason: PLAIN_READ }
    // A shell can send anything Gnomon read (mail subjects, pages, screen text)
    // anywhere, so it rides the outward ladder: refused under read-only and in a
    // job nobody can answer, asked under the default preset, free under Auto.
    if (toolName === 'bash') {
      const policy = presetPolicy('outward', preset, approvalOverride)
      if (policy === 'off') return { kind: 'deny', reason: `Gnomon: the '${preset ?? 'current'}' permission preset does not run shell commands.` }
      if (policy === 'ask') return { kind: 'ask', reason: `Gnomon: a shell command runs behind your approval (the '${preset ?? 'current'}' preset asks first).` }
    }
    return { kind: 'allow' }
  }

  // --- gnomon's own tools ---------------------------------------------------
  // A shell tool refuses destructive commands first, regardless of preset.
  if (gnomon.shell === true && facts.destructive !== null) return { kind: 'deny', reason: facts.destructive }

  // The preset is primary; config.actions can only tighten.
  const fromPreset = presetPolicy(gnomon.kind, preset, approvalOverride)
  const override = resolveActionPolicy(actions, gnomon.kind, gnomon.tool)
  const policy = stricter(fromPreset, override)
  // Under workspace-write (and full access), unless the owner's own config.actions says ask (or off) for this tool.
  if (gnomon.shell === true && facts.plainRead === true && override === 'auto' && freeReadPreset(preset, approvalOverride)) return { kind: 'allow', reason: PLAIN_READ }

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
 * J4.1: the second key, applied AFTER the code decision. The judge may turn an
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

// An integration tool named as a read, when the owner's config does not say.
const READ_VERB = /^(get|list|search|show|read|fetch|find|query|lookup|describe|count|view)(_|$)/i


/**
 * Set 2 R2: a plain read asks nothing under workspace-write. Set 1 measured 10 to 14 shell round trips a run at 1.5 to 1.7 s
 * each for a `cat` or a `find`, most of it the ask. Narrow on purpose (review 2026-11-15: 698 probes read the record and
 * dotfiles through a wider list): a few verbs, each with only the options listed here, and every file or folder it names an
 * absolute path under /tmp/gnomon* (the rig's jobs and fixtures; the rest of /tmp holds other tools' session files) after the
 * path is normalised: no `..`, no `~` or variable, no glob, no symlink-following option, firmlinks and case folded. Nothing
 * that names a database, the backups folder or Sundial's data folder in any spelling. The destructive, private-data,
 * own-secret and sleep guards still run first. Anything else asks as before.
 */
export const PLAIN_READ = 'a plain read'
/** Whether a shell command is a plain read (above): passes every guard, every part is a listed read, and every path it names is free. */
export function plainRead(command, env = process.env) {
  if (typeof command !== 'string' || command.trim() === '') return false
  if (classifyCommand(command).destructive || touchesOwnSecrets(command, env) || waitsBySleeping(command) || privateData(command)) return false
  if (/sundial-backups|\.db\b|\.sqlite|\.sundial/i.test(command)) return false
  // A stream to nowhere, or into the other one, writes no file.
  const parts = readParts(command.replace(/(?<=^|\s)(?:\d?>|&>)\s*\/dev\/null(?=\s|$)|(?<=^|\s)\d?>&\d(?=\s|$)/g, ' '))
  const paths = parts?.map(pathsOf)
  // The first part names what it reads; a later one may read the one before it.
  return Boolean(paths?.[0]?.length) && paths.every((p) => p !== null && p.every(freePath))
}

/**
 * J4.2: whether a call is one whose failure is worth telling the owner:
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
/**
 * R11: a call that never ran (the owner said no, stopped it, or dsh aborted it before dispatch).
 * That is a refusal (`action:decided` has it), not an action to verify. Matched on the error text,
 * the only mark these results carry.
 */
// ponytail: text match on dsh's and server.js's messages; a structured `refused` flag on the result if dsh grows one.
const NEVER_RAN = /the user rejected tool|tool call aborted before dispatch|the owner stopped this tool call/
export function neverRan(result) {
  if (result?.isError !== true) return false
  const parts = Array.isArray(result.content) ? result.content : Array.isArray(result.value) ? result.value : []
  return parts.some((p) => typeof p?.text === 'string' && NEVER_RAN.test(p.text))
}
const OUTWARD_WORDS = {
  gnomon_calendar_create: 'The calendar event Gnomon made',
  gnomon_reminder_create: 'The reminder Gnomon made',
  web_act: 'What Gnomon did on a web page',
  screen_act: 'What Gnomon did in an app on your screen',
  screen_undo: 'The value Gnomon put back in an app',
}

/**
 * J4.2: the notice a failed verification raises: one per tool, priced by the
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
