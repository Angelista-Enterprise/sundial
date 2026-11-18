import { describe, it, expect } from 'vitest';
import { createWindowSensorState, pollWindowChange, withPageUrl } from './index.js';
import type { WindowRef } from './window-capture.js';

const CODE: WindowRef = { processName: 'Code', windowTitle: 'a.ts', windowId: 'w1', documentPath: null };
const WARP: WindowRef = { processName: 'Warp', windowTitle: 'shell', windowId: 'w2', documentPath: null };

describe('pollWindowChange', () => {
  it('emits window:changed on the first real read', () => {
    const sensorState = createWindowSensorState();
    const event = pollWindowChange(CODE, sensorState);
    expect(event).toEqual({ type: 'window:changed', payload: { ...CODE, previousWindow: null, reason: 'focus' } });
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
    expect(event).toEqual({ type: 'window:changed', payload: { ...WARP, previousWindow: CODE, reason: 'focus' } });
  });

  it('S5R2: a sheet that comes on the same window emits nothing; the switch away carries it as previousWindow.sheet', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);
    expect(pollWindowChange({ ...CODE, sheet: true }, sensorState)).toBeNull();
    expect(pollWindowChange(WARP, sensorState)?.payload.previousWindow).toEqual({ ...CODE, sheet: true });
  });

  it('marks a rename of the same window as reason: title, not a switch', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(CODE, sensorState);
    const event = pollWindowChange({ ...CODE, windowTitle: 'b.ts' }, sensorState);
    expect(event?.payload.reason).toBe('title');
    expect(pollWindowChange({ ...CODE, windowId: 'w9' }, sensorState)?.payload.reason).toBe('focus');
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
    expect(event).toEqual({ type: 'window:changed', payload: { ...CODE, previousWindow: null, reason: 'focus' } });
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

describe('W6 D8: a browser window with no page URL', () => {
  const ZEN: WindowRef = { processName: 'Zen', windowTitle: 'Guide', windowId: 'z1', documentPath: null };
  const urlOf = (app: string, title: string) => (app === 'Zen' && title === 'Guide' ? 'https://docs.example.com/guide' : null);

  it('takes the page its title names, and leaves every other window as it was', () => {
    expect(withPageUrl(ZEN, urlOf)).toEqual({ ...ZEN, documentPath: 'https://docs.example.com/guide' });
    expect(withPageUrl({ ...ZEN, windowTitle: 'Other' }, urlOf)).toEqual({ ...ZEN, windowTitle: 'Other' });
    expect(withPageUrl({ ...CODE, documentPath: 'file:///repo/a.ts' }, () => 'https://wrong.example/')).toEqual({ ...CODE, documentPath: 'file:///repo/a.ts' });
    expect(withPageUrl(null, urlOf)).toBeNull();
  });

  it('says a page URL once when it arrives after the title, and stays silent when it goes away', () => {
    const sensorState = createWindowSensorState();
    pollWindowChange(ZEN, sensorState);
    const withUrl = { ...ZEN, documentPath: 'https://docs.example.com/guide' };
    expect(pollWindowChange(withUrl, sensorState)).toEqual({ type: 'window:changed', payload: { ...withUrl, previousWindow: ZEN, reason: 'title' } });
    expect(pollWindowChange(withUrl, sensorState)).toBeNull();
    expect(pollWindowChange(ZEN, sensorState)).toBeNull();
    expect(pollWindowChange(withUrl, sensorState)).toBeNull();
  });
});
