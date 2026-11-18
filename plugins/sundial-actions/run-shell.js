// gnomon_run_shell — the assistant's own shell action.
//
// Distinct from dsh's raw `bash` on purpose: it refuses destructive commands at
// execute time REGARDLESS of preset (see destructive.js), records what it ran
// as an `action:performed`, and caps runtime and output.
//
// It recorded that as an `assistant:proposal` until 2026-09-09, which was the
// wrong channel and quietly cost two things. `assistant:proposal` means "I
// suggest you do this, tell me yes or no": `assistantTrack` opens each one
// awaiting a verdict and `assistantAcceptanceRate` divides by the resolved
// ones. A shell command is not awaiting anything, so every command the
// assistant ran sat in that ledger as a permanently-open proposal — 23 of the
// 23 rows on the record were shell audit lines, no real proposal was
// distinguishable among them, and the acceptance rate the model is shown about
// its OWN track record was computed over a pool it could never resolve.
// `action:performed` is the channel that already means "I did a thing", which
// is what this is.
//
// SANDBOXED. Execution goes through dsh's confining ShellExecutor (`ctx.shell`),
// the same executor `bash` uses — so an approved command obeys the ACTIVE
// permission preset's sandbox: under `workspace-write` its file effects are
// confined to the workspace; under `danger-full-access` they are not. This is
// the unified permission story end to end: the gate maps the preset to
// allow/ask/deny, and the executor enforces the same preset on what actually
// runs. There is no raw-child_process path any more.
//
// The destructive denylist stays as a second layer the sandbox does not give:
// a `workspace-write` sandbox would happily let `rm -rf` shred the workspace
// itself, so a conservative refuse-when-unsure guard runs first, before the
// executor is ever asked.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendShellHookEntry } from '@sundial/helpers/shell-hook.js'
import { classifyCommand } from './destructive.js'
import { mailOf } from './gate-finals.js'
import { SHELL_SYNTAX, shellWords } from './gate-shell.js'

const DEFAULT_TIMEOUT_MS = 60_000
/** Runs 227 and 228: a job in the background holds no turn, so the foreground minute cut a 90 s build (exit -1, no last line). */
const BACKGROUND_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 100_000

/** AppleScript text as a string literal, and a line of it as a shell `-e` argument. */
const asString = (text) => `"${text.replace(/\\(.)/g, '$1').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const asArg = (line) => `-e '${line.replace(/'/g, "'\\''")}'`

/** Proof before a claim: after a Mail send, Mail's Sent mailbox is read for that subject and its recipients, sent since `startedAt`. The line the model reads. */
/** dsh 0.2's executor: `execute(spec)` gives the process handle, its `result()` the finished run. (0.1 had `run(spec)`.) */
const runOn = async (shell, spec) => (await shell.execute(spec)).result()

export async function confirmSent(mail, shell, cwd, startedAt = Date.now()) {
  if (!/^(mail|com\.apple\.mail)$/i.test(mail.app ?? '')) return 'Not confirmed: Gnomon cannot read the Sent mail of this path. Say what you ran, not that it was sent.'
  if (mail.subject === null) return 'Not confirmed: the subject is not readable in the command, so the Sent mailbox was not checked. Say what you ran, not that it was sent.'
  const script = [
    'tell application "Mail"',
    'set hits to {}',
    `set cutoff to (current date) - ${Math.ceil((Date.now() - startedAt) / 1000) + 1}`,
    'repeat 10 times',
    `set hits to (messages of sent mailbox whose subject is ${asString(mail.subject)} and date sent >= cutoff)`,
    'if hits is not {} then exit repeat',
    'delay 1.5',
    'end repeat',
    'if hits is {} then return ""',
    'set out to ""',
    'repeat with r in to recipients of (item 1 of hits)',
    'set out to out & (address of r) & linefeed',
    'end repeat',
    'return "found" & linefeed & out',
    'end tell',
  ]
  const result = await (async () => runOn(shell, shell.resolve({ command: `osascript ${script.map(asArg).join(' ')}`, workdir: cwd, timeoutMs: 25_000, stdoutMaxBytes: 10_000 })))().catch(() => null)
  const [found, ...sentTo] = String(result?.stdout?.text ?? '').trim().toLowerCase().split('\n').map((x) => x.trim())
  if (found !== 'found') return `Not confirmed: no mail with subject ${JSON.stringify(mail.subject)} reached Mail's Sent mailbox in 15 seconds (it may wait in the Outbox, or Mail refused it). Say so; do not say it was sent.`
  const missing = mail.to.filter((address) => !sentTo.includes(address.toLowerCase()))
  if (missing.length > 0) return `Not confirmed: Sent has a mail with that subject, but not to ${missing.join(', ')} (it went to ${sentTo.join(', ') || 'nobody readable'}).`
  return `Confirmed: Mail's Sent mailbox has ${JSON.stringify(mail.subject)}${sentTo.length ? ` to ${sentTo.join(', ')}` : ''}.`
}

// Rig run161: Gnomon waited for a job with a shell `sleep` although every description says use
// gnomon_await. So the command text is refused when it waits by sleeping: a `sleep` of a second or
// more (or an unreadable length), any sleep inside a while/until loop, a followed `tail` (a
// `timeout` around it is still a wait), and `watch`. A sleep under a second is not a wait.
export const SLEEP_REFUSAL = "Waiting by sleeping is refused: use gnomon_await (it waits for the job's end, a file, or a number of seconds) and then read the result."
const AT_COMMAND = String.raw`(?:^|[;&|(){}\n\x60"']|\$\()\s*(?:(?:do|then|else|nohup|exec|time|env|timeout\s+\S+)\s+)*`
const ARGS = String.raw`([^;&|(){}\n\x60"']*)`
const SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }
const sleepSeconds = (args) => args.trim().split(/\s+/).filter(Boolean).reduce((sum, arg) => {
  const m = /^(\d*\.?\d+)([smhd]?)$/.exec(arg)
  return sum + (m ? Number(m[1]) * SECONDS[m[2]] : Infinity)
}, 0)
export function waitsBySleeping(command) {
  const sleeps = [...command.matchAll(new RegExp(`${AT_COMMAND}sleep\\s+${ARGS}`, 'g'))].map((m) => sleepSeconds(m[1]))
  if (sleeps.some((s) => s >= 1)) return true
  if (sleeps.length > 0 && /(?:^|[;&|(\s])(?:while|until)\s/.test(command)) return true
  const follows = [...command.matchAll(new RegExp(`${AT_COMMAND}tail\\s+${ARGS}`, 'g'))].some((m) => /(?:^|\s)(?:--follow\S*|-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*)(?=\s|$)/.test(m[1]))
  return follows || new RegExp(`${AT_COMMAND}watch(?=\\s|$)`).test(command)
}

// A command that reads the install's own token, sign-in link, keys or session files, or calls its own
// web API, could approve its own asks. Refused in every preset. Other files in the data folder
// (config.json, say) stay readable. Ports and the data folder are read when the command is checked.
export const OWN_SECRETS_REFUSAL = "reading the assistant's own token, sign-in link, keys or session files, or calling its own web API, is refused: ask the owner to do it"
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Sundial's data folder in a command: any `.sundial*` folder, `$SUNDIAL_HOME`, or the path SUNDIAL_HOME holds. */
const sundialHome = (env = process.env) => new RegExp(`(?:\\.sundial[\\w.-]*|\\$\\{?SUNDIAL_HOME\\}?${env.SUNDIAL_HOME ? `|${escape(env.SUNDIAL_HOME)}` : ''})`)
export function touchesOwnSecrets(command, env = process.env) {
  if (/\.daemon\/|api-token|sundial\.log\b|\.credentials\.yaml|session-index\.sqlite|\$\{?DSH_HOME\b/.test(command)) return true
  const home = sundialHome(env)
  if (home.test(command)) {
    if (/(?:^|[\s/'"=])(?:\.env|\.daemon|logs|dsh)(?=[\s/'"]|$)/.test(command)) return true
    if (new RegExp(`${home.source}/\\S*[*?[]`).test(command)) return true
    if (new RegExp(`${home.source}/?(?=[\\s'"]|$)`).test(command) && /\s-[a-zA-Z]*[rR]\b|--recursive|(?:^|[\s|;&(])(?:find|tar|zip|rsync|xargs)\b/.test(command)) return true
  }
  const ports = ['3080', env.SUNDIAL_WEB_PORT].filter(Boolean).map(escape).join('|')
  return /\b(?:localhost|127\.\d+\.\d+\.\d+|127\.1|0\.0\.0\.0)\b|::1/.test(command) && new RegExp(`\\b(?:${ports})\\b|SUNDIAL_WEB_PORT`).test(command)
}

/** Commands that may name the database without opening it to write: a listing, or sqlite3 with -readonly. */
const DB_LOOKS = new Set(['ls', 'stat', 'du', 'file', 'wc'])
/**
 * What a shell command does to Sundial's own record (review, S2 R5). 'write': it names the database (sundial.db, or a .db or
 * .sqlite in the data folder) in a part that is not a listing or a `sqlite3 -readonly`, or redirects into it. Refused in
 * every chat: the log is written only through its tools (gnomon_assert, the feedback route), and the owner's legitimate
 * shell reads use -readonly; config.json and the rest of the folder stay writable for the owner. 'names': it names the
 * data folder, the database, the MCP server (`sundial mcp`, packages/mcp), the CLI (bin/sundial) or the token: refused
 * in a rig chat only, where any of those is a way around the fence. Else null.
 */
export function recordOf(command, env = process.env) {
  if (typeof command !== 'string' || command === '') return null
  const db = new RegExp(String.raw`\bsundial\.db\b|${sundialHome(env).source}/\S*\.(?:db|sqlite)\b`)
  if (db.test(command)) {
    const segments = [[]]
    for (const w of shellWords(command)) w.sep ? segments.push([]) : segments.at(-1).push(w)
    // A part that names it: a write unless a listing or sqlite3 -readonly. Named only inside a here-document (no part names it): a write.
    const naming = segments.filter((seg) => seg.some((w) => !w.out && db.test(w.text)))
    const writes = naming.length === 0 || naming.some((seg) => {
      const words = seg.filter((w) => !w.out).map((w) => w.text)
      while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || SHELL_SYNTAX.has(words[0]))) words.shift()
      return seg.some((w, i) => seg[i - 1]?.out && db.test(w.text)) || !(DB_LOOKS.has(words[0]) || (words[0] === 'sqlite3' && words.includes('-readonly')))
    })
    if (writes) return 'write'
  }
  return db.test(command) || sundialHome(env).test(command) || /\bsundial(?:\.js)?\s+mcp\b|\bbin\/sundial\b|\bpackages\/mcp\b|api-token/.test(command) ? 'names' : null
}

/**
 * The tool, given an `appendSignal` for the record, the workspace `cwd`, and
 * dsh's `shell` executor (ShellExecutor). Returned so index.js registers it
 * only when the preset/config permit.
 */
// `recordCommand` is the shell hook writer, injectable because the default
// appends to the OWNER'S real hook file: run-shell.test.js ran the real one,
// and its `touch /etc/nope` case wrote 266 fake commands (cwd "/ws") into the
// live record — 59 of one week's 69 "shell failures" were that test.
export function runShellTool(appendSignal, cwd, shell, { recordCommand = appendShellHookEntry } = {}) {
  return defineTool({
    name: 'gnomon_run_shell',
    // Run 43 T03: an osascript to TextEdit hung 66 s on the consent prompt. Run 54 T01: six obsidian:// rewrites of one note.
    // Runs 167, 186, 194, 204 T01: a python heredoc URL-encoded the note into obsidian://new, and the ask could not show it whole.
    description:
      'LAST RESORT: a gnomon_* read tool that answers the question comes first (gnomon_code_activity for files and commits, gnomon_agent_sessions for coding agents). Never read coding-agent transcripts or registries with it (~/.claude, ~/.codex, ~/.gemini, ~/.copilot, ~/.cursor): they are raw and unscrubbed; gnomon_agent_sessions has them scrubbed. An osascript that tells another app (TextEdit, Finder, Mail) can hang a minute on a macOS consent prompt only the owner can answer: read the file or use screen_look instead. An Obsidian note is a .md file in the vault: create it with a quoted heredoc (cat > "<vault>/<name>.md" <<\'EOF\' ... EOF), append with >>; obsidian:// URLs mangle quotes and $ and only show a note. Never build a note or an app URL in an inline python or node script: the owner approves what they can read, so open a plain URL. Runs in dsh\'s sandbox: under workspace-write, writes stay in the workspace. Destructive or system-level commands (recursive or forced deletes, disk writes, privilege escalation, power changes, force-push, piping remote content to a shell, credential reads) are refused: do not work around that, ask the owner to run them.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to run.' },
      timeoutMs: { type: 'number', description: `Optional timeout in ms (default ${DEFAULT_TIMEOUT_MS}; ${BACKGROUND_TIMEOUT_MS} in the background).` },
      background: { type: 'boolean', description: 'Start it and come back later: the call answers at once with a jobId, and gnomon_await {job: that id} ends the moment the job does. Use it for anything that takes more than a few seconds, and NEVER sleep to wait for one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ran: { type: 'boolean' },
          refused: { type: 'string' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
          stopped: { type: 'boolean' },
          sandboxDenied: { type: 'boolean' },
          sendCheck: { type: 'string' },
          started: { type: 'boolean' },
          jobId: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ran !== true) return [{ type: 'text', text: `Refused: ${value.refused}` }]
        if (value.started === true) return [{ type: 'text', text: value.note }]
        if (value.sandboxDenied) return [{ type: 'text', text: 'The sandbox blocked this command under the current permission preset.' }]
        if (value.stopped) return [{ type: 'text', text: 'The owner stopped this command before it finished. Its output is incomplete; do not re-run it unless they ask.' }]
        const body = [value.stdout, value.stderr].filter((s) => s && s.trim() !== '').join('\n').trim()
        return [{ type: 'text', text: `exit ${value.exitCode}${value.timedOut ? ' (timed out)' : ''}\n${body || '(no output)'}${value.sendCheck ? `\n${value.sendCheck}` : ''}` }]
      },
    },
    async execute(args, exec) {
      const command = String(args.command ?? '')
      // A mail's recipients and body stay off the record: the hook file and `action:performed` get a placeholder.
      const mail = mailOf(command)
      const recorded = mail ? 'a mail send, content not recorded' : command
      const verdict = classifyCommand(command)
      // Set 2 R3: one `shell:started` row per call, the chat's last shell call (rules shell-jobs.ts): the job it started, or that
      // it failed. gnomon_await reads it from the fold, so a running job is still known after a restart.
      const session = exec?.agent?.session?.id
      const started = (fields) => appendSignal('shell:started', { ...(session ? { session: String(session) } : {}), background: args.background === true, ...fields })
      // Recorded even when refused: an attempted destructive command is exactly the kind of thing the owner should be able to see later.
      const refuse = async (reason, audit = true) => {
        if (audit) await appendSignal('action:performed', { tool: 'run_shell', refused: reason, command: recorded.slice(0, 200) })
        await started({ failed: true, reason: String(reason).slice(0, 160) })
        return { ran: false, refused: reason }
      }
      if (verdict.destructive) return refuse(verdict.reason)
      if (touchesOwnSecrets(command)) return refuse(OWN_SECRETS_REFUSAL)
      // A job that sleeps inside itself is not the turn waiting: started in the background (or with a trailing `&`) it runs.
      if (args.background !== true && !/(?<!&)&\s*$/.test(command) && waitsBySleeping(command)) return refuse(SLEEP_REFUSAL)

      // No unsandboxed fallback: if the confining executor is absent, refuse
      // rather than run wide open. The web/headless profiles always provide it
      // (bash needs it too), so this is a guard, not an expected path.
      if (shell === undefined || shell === null || typeof shell.resolve !== 'function') return refuse('no sandboxed shell executor available', false)

      // Queued, not awaited: the kernel folds one signal at a time with its effects, so awaiting the append made a `cat` wait
      // behind whatever the lane was folding (Set 2 R2). The row still goes first, before any `shell:exited` of this job.
      void Promise.resolve(appendSignal('action:performed', { tool: 'run_shell', command: recorded.slice(0, 200) })).catch(() => {})
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? Math.min(args.timeoutMs, 600_000) : args.background === true ? BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS

      // The turn's cancellation signal, so the owner's Stop actually kills the
      // child. Without it `agent.cancel` aborted the driver while the command
      // ran on: a `sleep 400` survived the Stop, no `tool/result` was ever
      // written, and the turn stayed open for the full four hundred seconds
      // with the owner looking at a button that had apparently done nothing.
      // The executor's own contract says it kills on this signal; the tool
      // simply never handed it over.
      const spec = shell.resolve({ command, workdir: cwd, timeoutMs, stdoutMaxBytes: MAX_OUTPUT_BYTES, ...(exec?.signal ? { signal: exec.signal } : {}) })
      const startedAt = Date.now()

      // Runs 13 and 14 spent 48% of their clock asleep, because a job that takes a while could only be
      // waited for by guessing a number of seconds: 39 guessed for a 24 second job. Started in the
      // background, the job says when it ends — `shell:exited` on the record, folded, and gnomon_await
      // ends on it. The turn's own signal still kills it, so the owner's Stop still stops it.
      if (args.background === true) {
        const jobId = `job-${randomUUID().slice(0, 8)}`
        // Awaited, before the job runs: the wait that follows reads it from the fold, and it lands before this job's `shell:exited`.
        await started({ jobId })
        const ended = (exitCode, lastLine) => appendSignal('shell:exited', { jobId, exitCode, lastLine: String(lastLine ?? '').slice(0, 300), ms: Date.now() - startedAt })
        void runOn(shell, spec).then(
          (done) => ended(typeof done.exitCode === 'number' ? done.exitCode : -1, String(done.stdout?.text ?? '').trimEnd().split('\n').pop()),
          () => ended(-1, 'the job could not be run'),
        )
        // Run 219 T11: the model started a watcher like this one and answered at once that it "will report the end line when it
        // appears". Nothing does: a job's end reaches no one unless the turn waits for it.
        return { ran: true, started: true, jobId, note: `Started. Nothing tells you or the owner when it ends, so before you answer about it, wait for it with gnomon_await {job: "${jobId}"}, which comes back the moment it ends with its last line. Do not sleep.` }
      }
      // Queued like the row above. A run that throws is a failed start: its row supersedes this one.
      void Promise.resolve(started({})).catch(() => {})
      const result = await runOn(shell, spec).catch(async (error) => {
        await Promise.resolve(started({ failed: true })).catch(() => {})
        throw error
      })

      // Into the shell hook file as well as the proposal record. The proposal
      // says "the assistant chose to run this"; the hook entry is the command
      // itself, and it is what `gnomon_signals(shell)` reads. Before this, an
      // assistant-run command existed only as a proposal, so "did I run X
      // today" answered no while the command sat in the transcript.
      recordCommand({
        command: recorded,
        cwd,
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        durationMs: Date.now() - startedAt,
        ...(session ? { session: String(session) } : {}),
      })

      // An abort kill resolves like any other run, so it has to be named or it
      // reports as a command that exited badly on its own.
      const stopped = result.aborted === true || exec?.signal?.aborted === true
      const sendCheck = mail !== null && !stopped && result.exitCode === 0 && !result.sandbox?.denied ? await confirmSent(mail, shell, cwd, startedAt) : null
      return {
        ran: true,
        ...(stopped ? { stopped: true } : {}),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : result.exitCode === null ? -1 : 1,
        stdout: result.stdout?.text ?? '',
        stderr: result.stderr?.text ?? '',
        timedOut: Boolean(result.timedOut),
        ...(result.sandbox?.denied ? { sandboxDenied: true } : {}),
        ...(sendCheck === null ? {} : { sendCheck }),
      }
    },
  })
}
