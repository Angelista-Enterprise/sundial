import { type BadgeSnapshot, readNotificationSidecar } from './notification-capture.js';

export interface NotificationEvent {
  type: 'event:notification';
  payload: Record<string, unknown>;
}

export interface NotificationDiffState {
  /** The last count seen per app, so a rise is told per app and not from the total. */
  lastCounts: Record<string, number>;
}

export function createNotificationDiffState(): NotificationDiffState {
  return { lastCounts: {} };
}

/**
 * Badges that are not notifications: a pending software update sits on System
 * Settings and the App Store for weeks. It was present in 1,181 of the record's
 * 1,515 rising events, and a rise anywhere counted the whole Dock as "rising".
 */
export const OS_BADGE_APPS = new Set(['System Settings', 'System Preferences', 'App Store', 'Software Update']);

/**
 * Pure diff logic (allowlist filter + emit-only-on-change), separated from
 * the sidecar file read so it's directly unit-testable. Mutates `state` in
 * place and returns the event to emit, or null if nothing changed. An event
 * carries `rises`: each app whose count went up and by how much; `totalCount`,
 * `rising` and `delta` stay for the readers of the old rows.
 */
export function diffNotificationSnapshot(
  snapshot: BadgeSnapshot,
  state: NotificationDiffState,
  allowlist: string[] = [],
): NotificationEvent | null {
  const entries = Object.entries(snapshot.badges).filter(([app]) => !OS_BADGE_APPS.has(app) && (allowlist.length === 0 || allowlist.includes(app)));
  const counts = Object.fromEntries(entries);
  const apps = new Set([...Object.keys(counts), ...Object.keys(state.lastCounts)]);
  const rises: { app: string; delta: number }[] = [];
  let changed = false;
  for (const app of apps) {
    const d = (counts[app] ?? 0) - (state.lastCounts[app] ?? 0);
    if (d !== 0) changed = true;
    if (d > 0) rises.push({ app, delta: d });
  }
  if (!changed) return null;
  const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);
  const delta = totalCount - Object.values(state.lastCounts).reduce((a, b) => a + b, 0);
  state.lastCounts = counts;

  return {
    type: 'event:notification',
    payload: {
      timestamp: new Date().toISOString(),
      counts: entries.map(([app, count]) => ({ app, count, source: 'dock-badge' })),
      rises,
      totalCount,
      rising: rises.length > 0,
      delta,
    },
  };
}

/**
 * Emits only on badge-count change. `allowlist` empty (default) means every
 * Dock badge is included — matches `sensors.notification.apps` defaulting to
 * `[]` in WCS. No config-loading mechanism exists yet for this in Gnomon; a
 * constructor param stands in until one does.
 */
export class NotificationSensor {
  private readonly allowlist: string[];
  private readonly diffState = createNotificationDiffState();
  private lastSeenTimestamp: string | null = null;

  constructor(allowlist: string[] = []) {
    this.allowlist = allowlist;
  }

  poll(): NotificationEvent | null {
    const snapshot = readNotificationSidecar();
    if (!snapshot || snapshot.timestamp === this.lastSeenTimestamp) return null;
    this.lastSeenTimestamp = snapshot.timestamp;

    return diffNotificationSnapshot(snapshot, this.diffState, this.allowlist);
  }
}
