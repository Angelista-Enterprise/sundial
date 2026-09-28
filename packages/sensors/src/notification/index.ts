import { type BadgeSnapshot, readNotificationSidecar } from './notification-capture.js';

export interface NotificationEvent {
  type: 'event:notification';
  payload: Record<string, unknown>;
}

export interface NotificationDiffState {
  lastTotal: number;
}

export function createNotificationDiffState(): NotificationDiffState {
  return { lastTotal: 0 };
}

/**
 * Pure diff logic (allowlist filter + emit-only-on-change), separated from
 * the sidecar file read so it's directly unit-testable. Mutates `state` in
 * place and returns the event to emit, or null if nothing changed.
 */
export function diffNotificationSnapshot(
  snapshot: BadgeSnapshot,
  state: NotificationDiffState,
  allowlist: string[] = [],
): NotificationEvent | null {
  const entries = Object.entries(snapshot.badges).filter(([app]) => allowlist.length === 0 || allowlist.includes(app));
  const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);

  if (totalCount === state.lastTotal) return null;
  const delta = totalCount - state.lastTotal;
  state.lastTotal = totalCount;

  return {
    type: 'event:notification',
    payload: {
      timestamp: new Date().toISOString(),
      counts: entries.map(([app, count]) => ({ app, count, source: 'dock-badge' })),
      totalCount,
      rising: delta > 0,
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
