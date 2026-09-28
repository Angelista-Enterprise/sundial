// Shell witness: every command dsh runs, into Gnomon's shell hook file.
//
// The 2026-08-16 tooling audit asked "did I run X today?" and got a confident,
// wrong answer: `gnomon_signals(shell)` showed three commands from hours
// earlier while ~15 commands the agent had just run were absent. The cause was
// structural, not a latency bug. Gnomon's shell sensor prefers a hook file and
// falls back to parsing `~/.zsh_history`; nothing had ever written the hook
// file, and a non-interactive `bash -c` — which is exactly how dsh runs
// commands — writes no interactive history. So an agent's commands could never
// appear, at any delay.
//
// This closes the producer side. `tools/result` is dsh's observe-only
// notification after a call settles: it sees the tool name, the frozen
// arguments, and the outcome, and it cannot alter any of them. That makes it
// the right seam for a recorder — a witness must never be able to change what
// it witnesses, or fail the call it is recording.
//
// The sensor stays the single reader, so these commands enter the log through
// the same `shell:command` signal a human's typed command does. Gnomon gets ONE
// shell record, not an agent one and a human one.
//
// Named exports only.
import { appendShellHookEntry } from '@sundial/helpers/shell-hook.js';

/**
 * Tools whose call IS a shell command.
 *
 * `gnomon_run_shell` is deliberately absent: it writes its own hook entry at
 * the point of execution, where it knows the exit code and the real duration.
 * Listing it here too would double-count every assistant-run command.
 */
export const SHELL_TOOL_NAMES = new Set(['bash', 'bash_persistent', 'pwsh', 'shell']);

/**
 * The command and working directory of one shell tool call, or null when the
 * call is not one (or carries no command to record).
 *
 * `workdir` is bash's own argument name and is optional — when the model omits
 * it the executor uses the session cwd, which the caller supplies as the
 * fallback. Recording that fallback rather than null matters: `cwd` is how a
 * command gets attributed to a project later.
 */
export function extractShellCommand(exec, defaultCwd = null) {
  if (!exec || !SHELL_TOOL_NAMES.has(exec.name)) return null;
  const args = exec.arguments;
  if (args === null || typeof args !== 'object') return null;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (command.length === 0) return null;
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : defaultCwd;
  return { command, cwd: workdir ?? null, background: args.run_in_background === true };
}

/**
 * The exit code, when the outcome carries one.
 *
 * A failed tool call is not the same as a non-zero exit: the bash tool reports
 * `exit code: N` as a SUCCESSFUL tool result (the command ran, it just failed),
 * and reserves an error result for the call itself going wrong. So a tool
 * failure records `null` — "we do not know what it exited with" — rather than
 * inventing a code. A backgrounded command has no exit code yet either.
 */
export function extractExitCode(result) {
  if (!result || result.isError === true) return null;
  const value = result.value;
  if (value === null || typeof value !== 'object') return null;
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    if (typeof value[key] === 'number') return value[key];
  }
  return null;
}

/**
 * Build the `tools/result` listener.
 *
 * @param options.getDefaultCwd () => the session workspace, used when the call omits `workdir`
 * @param options.append injection point for the hook writer (tests)
 * @returns a listener for `ctx.on('tools/result', …)`
 */
export function createShellWitness({ getDefaultCwd = () => null, append = appendShellHookEntry } = {}) {
  return function witnessShellCall(exec, result) {
    let seen;
    try {
      seen = extractShellCommand(exec, getDefaultCwd());
    } catch {
      return; // A malformed execution view must not break the tool pipeline.
    }
    if (!seen) return;
    append({
      command: seen.command,
      cwd: seen.cwd,
      // A backgrounded command has not finished; its exit code belongs to the
      // job, not to this call.
      exitCode: seen.background ? null : extractExitCode(result),
    });
  };
}
