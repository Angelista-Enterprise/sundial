import { claudeRuntime } from './claude-cli.js';
import { copilotRuntime } from './copilot-sdk.js';
import { collectRun, type AgentRuntime, type RuntimeJob, type RuntimeRun } from './port.js';

export * from './port.js';
export { CLAUDE_MODELS, claudeArgs, claudeBinary, claudeEvents, claudeRuntime, INSTALL_ENV, isInstallKey, jobEnv, sundialMcp } from './claude-cli.js';
export { copilotEvents, copilotFailure, copilotRuntime } from './copilot-sdk.js';

/** The runtime sources the router knows, by source id. */
export const RUNTIME_SOURCES = ['claude', 'copilot'] as const;
export type RuntimeSource = (typeof RUNTIME_SOURCES)[number];
export const isRuntimeSource = (v: unknown): v is RuntimeSource => v === 'claude' || v === 'copilot';

const runtimes: Record<RuntimeSource, AgentRuntime> = { claude: claudeRuntime(), copilot: copilotRuntime() };
/** The runtime for a source; a test or a caller with a configured binary swaps one in with `setRuntime`. */
export function runtimeFor(source: RuntimeSource): AgentRuntime {
  return runtimes[source];
}
export function setRuntime(source: RuntimeSource, runtime: AgentRuntime | null): void {
  runtimes[source] = runtime ?? (source === 'claude' ? claudeRuntime() : copilotRuntime());
}

/**
 * One job over the runtime candidates in order: a limit (`error.kind ===
 * 'limit'`) moves to the next, anything else stops there. `onAttempt` is told
 * each attempt before it runs, so a caller can open its audit row; the result
 * carries the attempts in order.
 */
export async function runOnRuntimes(
  candidates: { source: RuntimeSource; model?: string }[],
  job: Omit<RuntimeJob, 'model'>,
  onAttempt?: (attempt: { index: number; source: RuntimeSource; model?: string }) => void | Promise<void>,
  onSettled?: (attempt: { index: number; source: RuntimeSource; model?: string }, run: RuntimeRun) => void | Promise<void>,
): Promise<{ source: RuntimeSource; model?: string; run: RuntimeRun; attempts: number }> {
  let last: { source: RuntimeSource; model?: string; run: RuntimeRun; attempts: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    await onAttempt?.({ index: i, ...c });
    const run = await collectRun(runtimeFor(c.source).run({ ...job, model: c.model }));
    await onSettled?.({ index: i, ...c }, run);
    last = { ...c, run, attempts: i + 1 };
    if (!run.error || run.error.kind !== 'limit' || i + 1 >= candidates.length) break;
  }
  if (!last) throw new Error('no runtime source to run the job on');
  return last;
}
