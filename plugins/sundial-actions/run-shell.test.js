// gnomon_run_shell runs through dsh's sandboxed ShellExecutor, never raw
// child_process — so an approved command obeys the active preset's sandbox.
import { describe, it, expect, vi } from 'vitest'
import { runShellTool } from './run-shell.js'

// A fake ShellExecutor: resolve() echoes the request as a spec, run() returns a
// canned ShellRunResult. Records the specs it was asked to run.
function fakeShell(runResult) {
  const runs = []
  return {
    runs,
    resolve: (req) => ({ ...req, workdir: req.workdir, timeoutMs: req.timeoutMs ?? 60000, stdoutMaxBytes: req.stdoutMaxBytes ?? 100000 }),
    run: async (spec) => {
      runs.push(spec)
      return runResult
    },
  }
}

const OK = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60000, stdout: { text: 'hello\n', truncated: false }, stderr: { text: '', truncated: false } }

/** Never the owner's real shell hook file (see run-shell.js). */
const NO_HOOK = { recordCommand: () => true }

describe('gnomon_run_shell', () => {
  it('runs a benign command through the sandboxed executor and returns its output', async () => {
    const appended = []
    const shell = fakeShell(OK)
    const tool = runShellTool(async (t, p) => appended.push({ t, p }), '/Users/x/Projects/sundial', shell, NO_HOOK)

    const out = await tool.execute({ command: 'echo hello' })
    expect(out).toMatchObject({ ran: true, exitCode: 0, stdout: 'hello\n', timedOut: false })
    // It went through resolve()+run(), in the workspace, NOT child_process.
    expect(shell.runs).toHaveLength(1)
    expect(shell.runs[0]).toMatchObject({ command: 'echo hello', workdir: '/Users/x/Projects/sundial' })
    // `action:performed`, NOT `assistant:proposal`. A command that ran is not a
    // suggestion awaiting the owner's yes: recorded on the proposal channel it
    // sat in the assistant's ledger as a permanently-open proposal and skewed
    // the acceptance rate the model is shown about its own track record.
    expect(appended[0].t).toBe('action:performed')
    expect(appended[0].p).toMatchObject({ tool: 'run_shell', command: 'echo hello' })
  })

  it('refuses a destructive command before touching the executor', async () => {
    const appended = []
    const shell = fakeShell(OK)
    const tool = runShellTool(async (t, p) => appended.push({ t, p }), '/ws', shell, NO_HOOK)

    const out = await tool.execute({ command: 'rm -rf ~' })
    expect(out.ran).toBe(false)
    expect(out.refused).toMatch(/destructive|delete/i)
    expect(shell.runs).toHaveLength(0) // never reached the executor
    // Still recorded — an attempted destructive command is exactly what the
    // owner should be able to find later — and on the same action channel.
    expect(appended[0].t).toBe('action:performed')
    expect(appended[0].p).toMatchObject({ tool: 'run_shell' })
    expect(appended[0].p.refused).toMatch(/destructive|delete/i)
  })

  it('surfaces a sandbox denial rather than pretending it ran', async () => {
    const denied = { ...OK, exitCode: null, sandbox: { mode: 'workspace-write', denied: true } }
    const tool = runShellTool(async () => {}, '/ws', fakeShell(denied), NO_HOOK)
    const out = await tool.execute({ command: 'touch /etc/nope' })
    expect(out.ran).toBe(true)
    expect(out.sandboxDenied).toBe(true)
  })

  it('refuses (does not run wide open) when no sandboxed executor is available', async () => {
    const tool = runShellTool(async () => {}, '/ws', undefined, NO_HOOK)
    const out = await tool.execute({ command: 'echo hi' })
    expect(out.ran).toBe(false)
    expect(out.refused).toMatch(/sandbox/i)
  })
})
