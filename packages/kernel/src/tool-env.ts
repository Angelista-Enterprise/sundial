import { loadLatestSnapshot } from './snapshot.js';
import type { ToolEnv } from './tools/registry.js';
import type { KernelState } from './types.js';

/**
 * The environment a tool call answers in (W4 step 5): the instant, and the state it reads.
 *
 * The harness passes its live `getState()`, so a tool in the chat sees what the
 * owner's screen sees; MCP runs in another process and reads the latest
 * snapshot (up to the snapshot interval behind). The clock is read here, once
 * per call, so a tool never reads it itself (fence F5).
 */
export function toolEnv(state?: () => KernelState | null | undefined, now = new Date()): ToolEnv {
  return { now, state: state ? async () => state() ?? null : async () => (await loadLatestSnapshot())?.state ?? null };
}
