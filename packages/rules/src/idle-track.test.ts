import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { idleTrack } from './idle-track.js';

function activityEvent(id: string, ts: string, counts: Partial<{ keyDownCount: number; mouseClickCount: number; mouseMoveCount: number; scrollCount: number }> = {}): SanitizedEvent {
  return { id, type: 'input:activity', ts, payload: { keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, ...counts }, sanitized: true };
}

function tsAt(n: number): string {
  return new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 10_000).toISOString();
}

describe('idleTrack', () => {
  it('does not flip idle on a single zero-activity window', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = idleTrack(state, activityEvent('e1', tsAt(0)));

    expect(next.lifeEvent.idle.isIdle).toBe(false);
    expect(next.lifeEvent.idle.consecutiveZeroWindows).toBe(1);
    expect(effects).toEqual([]);
  });

  it('emits idle:start after 30 consecutive zero-activity windows (~5 min)', () => {
    let state = createInitialState('d1');
    let lastEffects: ReturnType<typeof idleTrack>['effects'] = [];
    for (let i = 0; i < 30; i++) {
      const result = idleTrack(state, activityEvent(`e${i}`, tsAt(i)));
      state = result.state;
      lastEffects = result.effects;
    }

    expect(state.lifeEvent.idle.isIdle).toBe(true);
    expect(lastEffects).toEqual([{ type: 'EmitEvent', event: { id: expect.any(String), type: 'idle:start', ts: tsAt(29), payload: { timestamp: tsAt(29) } } }]);
  });

  it('resets the counter on any non-zero window, never reaching idle', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 29; i++) {
      state = idleTrack(state, activityEvent(`e${i}`, tsAt(i))).state;
    }
    // One keystroke right before the threshold resets the streak.
    state = idleTrack(state, activityEvent('e29', tsAt(29), { keyDownCount: 1 })).state;

    expect(state.lifeEvent.idle.consecutiveZeroWindows).toBe(0);
    expect(state.lifeEvent.idle.isIdle).toBe(false);
  });

  it('emits idle:end on the first non-zero window after being idle', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 30; i++) {
      state = idleTrack(state, activityEvent(`e${i}`, tsAt(i))).state;
    }
    expect(state.lifeEvent.idle.isIdle).toBe(true);

    const { state: next, effects } = idleTrack(state, activityEvent('e30', tsAt(30), { keyDownCount: 5 }));

    expect(next.lifeEvent.idle.isIdle).toBe(false);
    expect(next.lifeEvent.idle.consecutiveZeroWindows).toBe(0);
    expect(effects).toEqual([{ type: 'EmitEvent', event: { id: expect.any(String), type: 'idle:end', ts: tsAt(30), payload: { timestamp: tsAt(30) } } }]);
  });

  it('ignores non-input:activity events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: tsAt(0), payload: {}, sanitized: true };
    const { state: next, effects } = idleTrack(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('keeps the last window with real input, for the wall-clock break (U2-F1)', () => {
    let state = createInitialState('d1');
    state = idleTrack(state, activityEvent('e0', tsAt(0), { keyDownCount: 2 })).state;
    for (let i = 1; i < 40; i++) state = idleTrack(state, activityEvent(`e${i}`, tsAt(i))).state;
    expect(state.lifeEvent.idle.lastActiveAt).toBe(tsAt(0));
    state = idleTrack(state, activityEvent('e40', tsAt(40), { mouseMoveCount: 1 })).state;
    expect(state.lifeEvent.idle.lastActiveAt).toBe(tsAt(40));
  });
});
