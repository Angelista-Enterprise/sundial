import { readSleepWakeSidecar, type SleepWakeSnapshot } from './sleep-wake-capture.js';

export interface SleepWakeEvent {
  type: 'system:sleep-wake';
  payload: Record<string, unknown>;
}

/**
 * Sidecar-diff sensor, same pattern as `focus-mode` — emits only when the
 * sidecar's `timestamp` changes (a real new transition, not a re-read of the
 * same one). Replaces WCS's `pmset -g log` polling + idle-gap fallback
 * entirely (Wave 3e) — the notification-driven Swift source
 * (`SleepWakeCapture.swift`) makes the fallback unnecessary, the same way
 * the original sensor's own comment named as the eventual upgrade path.
 */
export class SleepWakeSensor {
  private lastTimestamp: string | null = null;

  poll(): SleepWakeEvent | null {
    const snapshot = readSleepWakeSidecar();
    if (!snapshot || snapshot.timestamp === this.lastTimestamp) return null;
    this.lastTimestamp = snapshot.timestamp;

    return {
      type: 'system:sleep-wake',
      payload: { timestamp: snapshot.timestamp, kind: snapshot.kind, source: 'workspace', gapSeconds: snapshot.gapSeconds ?? null },
    };
  }
}

export type { SleepWakeSnapshot };
