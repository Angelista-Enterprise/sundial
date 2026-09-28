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
}

export function createInputActivityAccumulator(now = Date.now()): InputActivityAccumulator {
  return { lastSeenTimestamp: null, windowStartedAt: now, keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0 };
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
    },
  };

  acc.windowStartedAt = now;
  acc.keyDownCount = 0;
  acc.mouseClickCount = 0;
  acc.mouseMoveCount = 0;
  acc.scrollCount = 0;

  return event;
}

export class InputActivitySensor {
  private readonly acc = createInputActivityAccumulator();

  poll(): InputActivityEvent | null {
    return accumulateInputActivity(readInputActivitySidecar(), this.acc);
  }
}
