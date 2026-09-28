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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendShellHookEntry } from '@sundial/helpers/shell-hook.js'
import { classifyCommand } from './destructive.js'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 100_000

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
    description:
      'LAST RESORT. A gnomon_* read tool that answers the question comes first (gnomon_code_activity for files and commits, gnomon_signals for the raw stream, gnomon_look for what a card shows); one call in three here fails. Run a shell command in the workspace and return its output. Runs inside dsh\'s sandbox, so under the workspace-write preset its file writes are confined to the workspace. Destructive or system-level commands (recursive/forced deletes, disk writes, privilege escalation, power changes, force-push, piping remote content to a shell, credential reads) are refused outright — do not try to work around that, ask the owner to run those themselves.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to run.' },
      timeoutMs: { type: 'number', description: `Optional timeout in ms (default ${DEFAULT_TIMEOUT_MS}).` },
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
        },
      },
      render: (_args, value) => {
        if (value.ran !== true) return [{ type: 'text', text: `Refused: ${value.refused}` }]
        if (value.sandboxDenied) return [{ type: 'text', text: 'The sandbox blocked this command under the current permission preset.' }]
        if (value.stopped) return [{ type: 'text', text: 'The owner stopped this command before it finished. Its output is incomplete; do not re-run it unless they ask.' }]
        const body = [value.stdout, value.stderr].filter((s) => s && s.trim() !== '').join('\n').trim()
        return [{ type: 'text', text: `exit ${value.exitCode}${value.timedOut ? ' (timed out)' : ''}\n${body || '(no output)'}` }]
      },
    },
    async execute(args, exec) {
      const command = String(args.command ?? '')
      const verdict = classifyCommand(command)
      if (verdict.destructive) {
        // Recorded even when refused: an attempted destructive command is
        // exactly the kind of thing the owner should be able to see later.
        await appendSignal('action:performed', { tool: 'run_shell', refused: verdict.reason, command: command.slice(0, 200) })
        return { ran: false, refused: verdict.reason }
      }

      // No unsandboxed fallback: if the confining executor is absent, refuse
      // rather than run wide open. The web/headless profiles always provide it
      // (bash needs it too), so this is a guard, not an expected path.
      if (shell === undefined || shell === null || typeof shell.resolve !== 'function') {
        return { ran: false, refused: 'no sandboxed shell executor available' }
      }

      await appendSignal('action:performed', { tool: 'run_shell', command: command.slice(0, 200) })
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? Math.min(args.timeoutMs, 600_000) : DEFAULT_TIMEOUT_MS

      // The turn's cancellation signal, so the owner's Stop actually kills the
      // child. Without it `agent.cancel` aborted the driver while the command
      // ran on: a `sleep 400` survived the Stop, no `tool/result` was ever
      // written, and the turn stayed open for the full four hundred seconds
      // with the owner looking at a button that had apparently done nothing.
      // The executor's own contract says it kills on this signal; the tool
      // simply never handed it over.
      const spec = shell.resolve({ command, workdir: cwd, timeoutMs, stdoutMaxBytes: MAX_OUTPUT_BYTES, ...(exec?.signal ? { signal: exec.signal } : {}) })
      const startedAt = Date.now()
      const result = await shell.run(spec)

      // Into the shell hook file as well as the proposal record. The proposal
      // says "the assistant chose to run this"; the hook entry is the command
      // itself, and it is what `gnomon_signals(shell)` reads. Before this, an
      // assistant-run command existed only as a proposal, so "did I run X
      // today" answered no while the command sat in the transcript.
      recordCommand({
        command,
        cwd,
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        durationMs: Date.now() - startedAt,
      })

      // An abort kill resolves like any other run, so it has to be named or it
      // reports as a command that exited badly on its own.
      const stopped = result.aborted === true || exec?.signal?.aborted === true
      return {
        ran: true,
        ...(stopped ? { stopped: true } : {}),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : result.exitCode === null ? -1 : 1,
        stdout: result.stdout?.text ?? '',
        stderr: result.stderr?.text ?? '',
        timedOut: Boolean(result.timedOut),
        ...(result.sandbox?.denied ? { sandboxDenied: true } : {}),
      }
    },
  })
}
