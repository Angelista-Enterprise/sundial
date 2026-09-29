import { type InputActivitySnapshot, readInputActivitySidecar } from './input-activity-capture.js';

export interface InputActivityEvent {
  type: 'input:activity';
  payload: Record<string, unknown>;
}

export interface InputActivityAccumulator {
  lastSeenTimestamp: string | null;
  windowStartedAt: number;
  keyDownCount: number;
  mouseClickCount: number;
  mouseMoveCount: number;
  scrollCount: number;
  /** A fresh sidecar snapshot arrived in this window. */
  fresh: boolean;
  /** The grant flags of the newest snapshot in this window. */
  listenAccessGranted?: boolean;
  tapActive?: boolean;
}

export function createInputActivityAccumulator(now = Date.now()): InputActivityAccumulator {
  return { lastSeenTimestamp: null, windowStartedAt: now, keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, fresh: false };
}

const EMIT_WINDOW_MS = 10_000;

/**
 * Pure accumulation logic, separated from the sidecar file read so it's
 * directly unit-testable. The Swift sidecar resets its own counters every
 * 1s and writes a fresh snapshot; this accumulates those 1s snapshots into
 * a larger emit window (10s) before producing one `input:activity` event.
 * Mutates `acc` in place; returns the event once the window has elapsed, or
 * null otherwise.
 */
export function accumulateInputActivity(
  snapshot: InputActivitySnapshot | null,
  acc: InputActivityAccumulator,
  now = Date.now(),
): InputActivityEvent | null {
  if (snapshot && snapshot.timestamp !== acc.lastSeenTimestamp) {
    acc.lastSeenTimestamp = snapshot.timestamp;
    acc.keyDownCount += snapshot.keyDownCount;
    acc.mouseClickCount += snapshot.mouseClickCount;
    acc.mouseMoveCount += snapshot.mouseMoveCount;
    acc.scrollCount += snapshot.scrollCount;
    acc.fresh = true;
    if (snapshot.listenAccessGranted !== undefined) acc.listenAccessGranted = snapshot.listenAccessGranted;
    if (snapshot.tapActive !== undefined) acc.tapActive = snapshot.tapActive;
  }

  const elapsed = now - acc.windowStartedAt;
  if (elapsed < EMIT_WINDOW_MS) return null;

  const total = acc.keyDownCount + acc.mouseClickCount + acc.mouseMoveCount + acc.scrollCount;
  const event: InputActivityEvent = {
    type: 'input:activity',
    payload: {
      timestamp: new Date(now).toISOString(),
      windowMs: elapsed,
      keyDownCount: acc.keyDownCount,
      mouseClickCount: acc.mouseClickCount,
      mouseMoveCount: acc.mouseMoveCount,
      scrollCount: acc.scrollCount,
      eventsPerMinute: Math.round((total * 60_000) / elapsed),
      // lane H (H1): the helper's own grant report, so a dropped grant is a
      // fact in the log and not a run of zeros that looks like a quiet owner.
      // `stale`: no fresh snapshot this window — the counts are not a reading.
      ...(acc.fresh ? {} : { stale: true }),
      ...(acc.fresh && acc.listenAccessGranted !== undefined ? { listenAccessGranted: acc.listenAccessGranted } : {}),
      ...(acc.fresh && acc.tapActive !== undefined ? { tapActive: acc.tapActive } : {}),
    },
  };

  acc.windowStartedAt = now;
  acc.keyDownCount = 0;
  acc.mouseClickCount = 0;
  acc.mouseMoveCount = 0;
  acc.scrollCount = 0;
  acc.fresh = false;

  return event;
}

export class InputActivitySensor {
  private readonly acc = createInputActivityAccumulator();

  poll(): InputActivityEvent | null {
    return accumulateInputActivity(readInputActivitySidecar(), this.acc);
  }
}
