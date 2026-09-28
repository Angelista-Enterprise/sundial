import { describe, it, expect } from 'vitest';
import { createWindowSensorState, pollWindowChange } from './index.js';
import type { WindowRef } from './window-capture.js';

const CODE: WindowRef = { processName: 'Code', windowTitle: 'a.ts', windowId: 'w1', documentPath: null };
const WARP: WindowRef = { processName: 'Warp', windowTitle: 'shell', windowId: 'w2', documentPath: null };

describe('pollWindowChange', () => {
  it('emits window:changed on the first real read', () => {
    const sensorState = createWindowSensorState();
    const event = pollWindowChange(CODE, sensorState);
    expect(event).toEqual({ type: 'window:changed', payload: { ...CODE, previousWindow: null } });
  });

  it('emits nothing when the same window is read again', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);
    expect(pollWindowChange(CODE, sensorState)).toBeNull();
  });

  it('emits window:changed when a genuinely different window is read', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);
    const event = pollWindowChange(WARP, sensorState);
    expect(event).toEqual({ type: 'window:changed', payload: { ...WARP, previousWindow: CODE } });
  });

  it('B1/A§4.7: survives a brief sidecar hiccup — the same window re-read after 1-2 stale reads does not re-fire', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);

    expect(pollWindowChange(null, sensorState)).toBeNull();
    expect(pollWindowChange(null, sensorState)).toBeNull();
    // Recovers within the grace window — same window, should NOT look like a change.
    expect(pollWindowChange(CODE, sensorState)).toBeNull();
  });

  it('treats focus as genuinely lost after MAX_STALE_READS_BEFORE_RESET consecutive failures, re-firing on recovery', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);

    pollWindowChange(null, sensorState);
    pollWindowChange(null, sensorState);
    pollWindowChange(null, sensorState);

    // Focus was reset — the same window reappearing now looks like a fresh change (previousWindow: null).
    const event = pollWindowChange(CODE, sensorState);
    expect(event).toEqual({ type: 'window:changed', payload: { ...CODE, previousWindow: null } });
  });

  it('resets the stale-read counter on any successful read', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);
    pollWindowChange(null, sensorState);
    pollWindowChange(null, sensorState);
    pollWindowChange(CODE, sensorState); // resets staleReadCount back to 0
    pollWindowChange(null, sensorState);
    pollWindowChange(null, sensorState);

    // Only 2 consecutive stale reads since the last recovery — still under threshold.
    expect(pollWindowChange(CODE, sensorState)).toBeNull();
  });
});
