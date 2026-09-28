import type { Rule } from '@sundial/kernel/types.js';

interface NotificationPayload {
  timestamp?: string;
  counts?: { app?: string; count?: number; source?: string }[];
  totalCount?: number;
}

/**
 * `event:notification` (947 rows) reported Dock badge counts per app and
 * nothing folded them. `state.pressure.byApp` keeps the current count per app
 * and — the part a badge alone cannot say — SINCE WHEN it has sat at that
 * value. "Slack has been at 14 unread for three hours" is a statement about the
 * owner's attention, not about Slack, and it is the input the noticing gate's
 * interruption-cost term has been missing.
 *
 * An app that leaves the payload has cleared its badge and leaves the slice.
 */
export const pressureTrack: Rule = (state, event) => {
  if (event.type !== 'event:notification') return { state, effects: [] };
  const payload = event.payload as NotificationPayload;
  const counts = Array.isArray(payload.counts) ? payload.counts : [];

  const byApp: typeof state.pressure.byApp = {};
  let total = 0;
  for (const entry of counts) {
    const app = typeof entry.app === 'string' ? entry.app.trim() : '';
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
    if (app === '' || count <= 0) continue;
    const prior = state.pressure.byApp[app];
    byApp[app] = { count, since: prior && prior.count === count ? prior.since : event.ts, updatedAt: event.ts };
    total += count;
  }

  return { state: { ...state, pressure: { byApp, total, updatedAt: event.ts } }, effects: [] };
};

/** Apps whose badge has sat unchanged at `minCount` or more for at least `minMs`. */
export function standingPressure(byApp: Record<string, { count: number; since: string }>, nowMs: number, minCount = 5, minMs = 2 * 60 * 60 * 1000): { app: string; count: number; hours: number }[] {
  const out: { app: string; count: number; hours: number }[] = [];
  for (const [app, entry] of Object.entries(byApp)) {
    const age = nowMs - Date.parse(entry.since);
    if (entry.count >= minCount && age >= minMs) out.push({ app, count: entry.count, hours: Math.round(age / 3_600_000) });
  }
  return out.sort((a, b) => b.hours - a.hours);
}
