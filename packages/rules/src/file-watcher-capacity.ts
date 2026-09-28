import type { Rule } from '@sundial/kernel/types.js';

interface FileWatcherCapacityPayload {
  maxRoots?: number;
  activeRoots?: string[];
  rejectedRoot?: string;
}

/**
 * Surfaces file-watcher capacity exhaustion. The file-watcher sensor caps how
 * many project roots it watches at once; when a newly-focused root can't be
 * slotted in and none can be evicted, it emits `file-watcher:capacity`
 * (`packages/sensors/src/file-watcher/index.ts`) — previously a dead-end event
 * no rule consumed, so file-change tracking for the rejected root silently
 * stopped with no attributable cause. This emits a `Notify` effect naming the
 * rejected root and the active set, so at least the daemon logs it (the only
 * surfacing available while there's no notification UI). Pure projection, no
 * state change, no ordering constraint.
 */
export const fileWatcherCapacity: Rule = (state, event) => {
  if (event.type !== 'file-watcher:capacity') return { state, effects: [] };
  const payload = event.payload as FileWatcherCapacityPayload;
  return {
    state,
    effects: [
      {
        type: 'Notify',
        channel: 'file-watcher-capacity',
        payload: {
          rejectedRoot: payload.rejectedRoot ?? null,
          maxRoots: payload.maxRoots ?? null,
          activeRoots: Array.isArray(payload.activeRoots) ? payload.activeRoots : [],
        },
      },
    ],
  };
};
