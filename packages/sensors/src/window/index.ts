import { sessionStore } from '../browser/session-store.js';
import { readWindowSidecar, type WindowRef } from './window-capture.js';

export interface WindowChangedPayload {
  processName: string;
  windowTitle: string;
  windowId: string;
  documentPath: string | null;
  /** S5R2: a sheet or dialog in front of the window; `previousWindow.sheet` is the app as it was left. */
  sheet?: true;
  previousWindow: WindowRef | null;
  /**
   * `focus` when another window (or app) took the front; `title` when the same
   * window renamed itself (a terminal running a build, an agent rewriting its
   * title, an editor moving between files). 44% of the record's events were
   * title changes with no reason attached, so every switch count measured the
   * terminal. Count `focus` for switches; read `title` for progress.
   */
  reason: 'focus' | 'title';
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
  // A document that arrives after its title (a session file is up to 15 s late) is said once; one that goes away is not.
  const documentArrived = lastWindow?.documentPath === null && current.documentPath !== null;
  if (lastWindow && lastWindow.windowId === current.windowId && lastWindow.windowTitle === current.windowTitle && !documentArrived) {
    // S5R2: a sheet that came or went emits nothing; the switch away says it, as its `previousWindow` (opened-track.ts).
    if (lastWindow.sheet !== current.sheet) sensorState.lastWindow = current;
    return null;
  }

  const previousWindow = lastWindow;
  sensorState.lastWindow = current;
  const reason = lastWindow && lastWindow.windowId === current.windowId && lastWindow.processName === current.processName ? 'title' : 'focus';
  return { type: 'window:changed', payload: { ...current, previousWindow, reason } };
}

const sensorState = createWindowSensorState();

/** The app in front as of the last poll, for a sensor that needs a second witness. */
export const frontProcessName = (): string | null => sensorState.lastWindow?.processName ?? null;

/**
 * W6 D8: a Firefox-family window has no page URL (Accessibility gives none), so no URL rule could
 * place it in a project. Its session file names the page with the window's own title.
 */
export function withPageUrl(current: WindowRef | null, urlOf: (app: string, windowTitle: string) => string | null): WindowRef | null {
  if (!current || current.documentPath !== null) return current;
  const url = urlOf(current.processName, current.windowTitle);
  return url === null ? current : { ...current, documentPath: url };
}

/** Called once per poll tick by the daemon. */
export function pollWindowSensor(): SensorEvent | null {
  return pollWindowChange(withPageUrl(readWindowSidecar(), (app, title) => sessionStore.urlOf(app, title)), sensorState);
}
