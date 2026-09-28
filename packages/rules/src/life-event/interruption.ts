import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

interface NotificationPayload {
  rising?: boolean;
  counts?: { app?: string; count?: number }[];
}

/**
 * Only the notification path is implemented this wave. The micro-break path
 * needs an `idle:end` signal and the in-call path needs `event:in-call` —
 * neither exists anywhere in Gnomon (confirmed: no idle-detection sensor at
 * all yet). Both are real, honest gaps, not silently dropped — see
 * docs/phase-3-implementation-plan.md's Wave 3e notes.
 */
export const interruption: Rule = (state, event) => {
  if (event.type !== 'event:notification') return { state, effects: [] };
  if (!state.moment) return { state, effects: [] };

  const payload = event.payload as NotificationPayload;
  if (!payload.rising) return { state, effects: [] };

  const apps = (payload.counts ?? [])
    .map((c) => c.app)
    .filter((app): app is string => Boolean(app))
    .slice(0, 3);

  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'interruption'),
          type: 'event:interruption',
          ts: event.ts,
          payload: { timestamp: event.ts, momentId: state.moment.id, cause: 'notification', detail: apps.length > 0 ? apps.join(', ') : null },
        },
      },
    ],
  };
};
