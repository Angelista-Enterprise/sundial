// Plan 15 step 1: the ends of the owner's tasks. The gate looks at what it holds at each one.
import { deriveId } from '@sundial/helpers/derive-id.js';
import { BUILD_CMD_RE } from '@sundial/kernel/read/summon-evidence.js';
import type { KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { testKey } from './life-event/test-recovery.js';

/** `idle:start` comes after 5 quiet minutes, so 10 more is a break of 15. */
export const RETURN_AFTER_IDLE_MS = 10 * 60_000;

export type BoundaryKind = 'commit' | 'test-end' | 'call-end' | 'return' | 'agent-stop';

function boundaryOf(state: KernelState, event: SanitizedEvent): BoundaryKind | null {
  const p = event.payload as { command?: unknown; exitCode?: unknown; event?: unknown };
  switch (event.type) {
    case 'git:commit':
      return 'commit';
    case 'shell:command':
      return typeof p.exitCode === 'number' && typeof p.command === 'string' && (testKey(p.command) !== null || BUILD_CMD_RE.test(p.command)) ? 'test-end' : null;
    case 'media:state':
      // After `callSpanTrack`: the call closed on this event.
      return !state.av?.call && state.av?.lastCall?.until === event.ts ? 'call-end' : null;
    case 'idle:end': {
      const since = state.boundary?.idleSince;
      return typeof since === 'string' && Date.parse(event.ts) - Date.parse(since) >= RETURN_AFTER_IDLE_MS ? 'return' : null;
    }
    case 'agent:hook':
      return p.event === 'Stop' ? 'agent-stop' : null;
    default:
      return null;
  }
}

/** Single writer of `state.boundary`. Says `boundary:reached { kind }` at a commit, the end of a test or build run, the end of a call, the return from a break, and an agent's stop. */
export const boundaryTrack: Rule = (state, event) => {
  const last = state.boundary?.last ?? null;
  if (event.type === 'idle:start') return { state: { ...state, boundary: { last, idleSince: event.ts } }, effects: [] };
  const kind = boundaryOf(state, event);
  if (kind === null) return event.type === 'idle:end' ? { state: { ...state, boundary: { last, idleSince: null } }, effects: [] } : { state, effects: [] };
  return {
    state: { ...state, boundary: { last: { kind, at: event.ts }, idleSince: event.type === 'idle:end' ? null : (state.boundary?.idleSince ?? null) } },
    effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'boundary-track', kind), type: 'boundary:reached', ts: event.ts, payload: { kind } } }],
  };
};
