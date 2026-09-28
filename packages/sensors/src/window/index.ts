import { readWindowSidecar, type WindowRef } from './window-capture.js';

export interface WindowChangedPayload {
  processName: string;
  windowTitle: string;
  windowId: string;
  documentPath: string | null;
  previousWindow: WindowRef | null;
}

export interface SensorEvent {
  type: 'window:changed';
  payload: WindowChangedPayload;
}

export interface WindowSensorState {
  lastWindow: WindowRef | null;
  staleReadCount: number;
}

export function createWindowSensorState(): WindowSensorState {
  return { lastWindow: null, staleReadCount: 0 };
}

// B1/A§4.7 (docs/audit/production-proposal-and-enhancements.md) — a single
// transient sidecar read failure (a helper hiccup lasting a few seconds)
// used to null `lastWindow` immediately, so the next successful read of the
// SAME window looked like a real change: one continuous session split into
// two, firing the full pre-close rule battery (2 LLM calls, an embedding, an
// anomaly sample) for a non-event. Requiring a few consecutive failures
// before treating focus as genuinely lost survives a brief hiccup without
// losing real staleness detection — focus lost for real still resets after
// `MAX_STALE_READS_BEFORE_RESET` polls.
const MAX_STALE_READS_BEFORE_RESET = 3;

/**
 * Pure poll logic, separated from the sidecar file read (same split as
 * `accumulateInputActivity`, packages/sensors/src/input-activity/index.ts)
 * so it's directly unit-testable. Mutates `sensorState` in place. Emits
 * `window:changed` only on an actual change (per docs/design/01-events-and-
 * log.md — a sensor emits typed events, nothing else).
 */
export function pollWindowChange(current: WindowRef | null, sensorState: WindowSensorState): SensorEvent | null {
  if (!current) {
    sensorState.staleReadCount += 1;
    if (sensorState.staleReadCount >= MAX_STALE_READS_BEFORE_RESET) {
      sensorState.lastWindow = null;
    }
    return null;
  }
  sensorState.staleReadCount = 0;

  const { lastWindow } = sensorState;
  if (lastWindow && lastWindow.windowId === current.windowId && lastWindow.windowTitle === current.windowTitle) {
    return null;
  }

  const previousWindow = lastWindow;
  sensorState.lastWindow = current;
  return { type: 'window:changed', payload: { ...current, previousWindow } };
}

const sensorState = createWindowSensorState();

/** Called once per poll tick by the daemon. */
export function pollWindowSensor(): SensorEvent | null {
  return pollWindowChange(readWindowSidecar(), sensorState);
}
