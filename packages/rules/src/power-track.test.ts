import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { powerTrack } from './power-track.js';

function event(payload: Record<string, unknown>, ts = '2026-01-01T00:00:00.000Z'): SanitizedEvent {
  return { id: 'e1', type: 'system:power', ts, payload, sanitized: true };
}

describe('powerTrack', () => {
  it('writes source, batteryPercent, charging, and timeRemainingMinutes', () => {
    const state = createInitialState('d1');
    const { state: next } = powerTrack(state, event({ source: 'battery', batteryPercent: 42, charging: false, timeRemainingMinutes: 90 }));
    expect(next.power).toEqual({ source: 'battery', batteryPercent: 42, charging: false, timeRemainingMinutes: 90 });
  });

  it('defaults source to ac for anything other than "battery"', () => {
    const state = createInitialState('d1');
    const { state: next } = powerTrack(state, event({ source: 'weird' }));
    expect(next.power.source).toBe('ac');
  });

  it('leaves batteryPercent/charging undefined when absent, timeRemainingMinutes null', () => {
    const state = createInitialState('d1');
    const { state: next } = powerTrack(state, event({ source: 'ac' }));
    expect(next.power).toEqual({ source: 'ac', batteryPercent: undefined, charging: undefined, timeRemainingMinutes: null });
  });

  it('ignores non-system:power events', () => {
    const state = createInitialState('d1');
    const other: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = powerTrack(state, other);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
