import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { phoneTrack } from './phone-track.js';

function ev(type: string, payload: Record<string, unknown>, ts = '2026-01-01T09:12:00.000Z'): SanitizedEvent {
  return { id: 'e1', type, ts, payload, sanitized: true };
}

describe('phoneTrack', () => {
  it('ignores unrelated event types', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = phoneTrack(state, ev('window:changed', {}));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('records an arrival at a labelled place', () => {
    const { state: next } = phoneTrack(createInitialState('d1'), ev('phone:place', { label: 'office', arrival: '2026-01-01T09:12:00.000Z' }));
    // `observedHours` is the desk machine's own coverage (`coverageTrack`), untouched
    // by anything the phone reports — asserted here so the two halves of this slice
    // stay visibly independent.
    expect(next.coverage).toEqual({ place: 'office', placeSince: '2026-01-01T09:12:00.000Z', lastSleepEnd: null, activity: null, activitySince: null, updatedAt: '2026-01-01T09:12:00.000Z', observedHours: {} });
  });

  it('records the latest motion state as the live activity readout', () => {
    const { state: next } = phoneTrack(createInitialState('d1'), ev('phone:motion', { state: 'automotive', start: '2026-01-01T08:00:00.000Z' }, '2026-01-01T08:00:05.000Z'));
    expect(next.coverage.activity).toBe('automotive');
    expect(next.coverage.activitySince).toBe('2026-01-01T08:00:00.000Z');
    expect(next.coverage.updatedAt).toBe('2026-01-01T08:00:05.000Z');
  });

  it('leaves place and sleep untouched when only motion updates', () => {
    let state = phoneTrack(createInitialState('d1'), ev('phone:place', { label: 'office', arrival: '2026-01-01T09:12:00.000Z' })).state;
    state = phoneTrack(state, ev('phone:motion', { state: 'stationary', start: '2026-01-01T09:20:00.000Z' })).state;
    expect(state.coverage.place).toBe('office');
    expect(state.coverage.activity).toBe('stationary');
  });

  it('clears the place when the owner leaves it (departure set)', () => {
    let state = phoneTrack(createInitialState('d1'), ev('phone:place', { label: 'office', arrival: '2026-01-01T09:12:00.000Z' })).state;
    state = phoneTrack(state, ev('phone:place', { label: 'office', arrival: '2026-01-01T09:12:00.000Z', departure: '2026-01-01T17:40:00.000Z' }, '2026-01-01T17:40:00.000Z')).state;
    expect(state.coverage.place).toBeNull();
    expect(state.coverage.placeSince).toBeNull();
    expect(state.coverage.updatedAt).toBe('2026-01-01T17:40:00.000Z');
  });

  it('does not let a late report about an earlier place wipe a newer arrival', () => {
    let state = phoneTrack(createInitialState('d1'), ev('phone:place', { label: 'gym', arrival: '2026-01-01T18:00:00.000Z' }, '2026-01-01T18:00:00.000Z')).state;
    // A completed 'office' visit reported after we already show 'gym' must not clear gym.
    state = phoneTrack(state, ev('phone:place', { label: 'office', arrival: '2026-01-01T09:12:00.000Z', departure: '2026-01-01T17:40:00.000Z' }, '2026-01-01T18:01:00.000Z')).state;
    expect(state.coverage.place).toBe('gym');
  });

  it('records the end of a sleep interval as "awake since"', () => {
    const { state: next } = phoneTrack(createInitialState('d1'), ev('phone:sleep', { start: '2026-01-01T23:00:00.000Z', end: '2026-01-02T07:10:00.000Z' }, '2026-01-02T07:15:00.000Z'));
    expect(next.coverage.lastSleepEnd).toBe('2026-01-02T07:10:00.000Z');
    expect(next.coverage.updatedAt).toBe('2026-01-02T07:15:00.000Z');
  });

  it.each([
    ['a place with no label', 'phone:place', { arrival: '2026-01-01T09:12:00.000Z' }],
    ['a place with a blank label', 'phone:place', { label: '   ', arrival: '2026-01-01T09:12:00.000Z' }],
    ['a place with an unparseable arrival', 'phone:place', { label: 'office', arrival: 'whenever' }],
    ['a sleep with a missing end', 'phone:sleep', { start: '2026-01-01T23:00:00.000Z' }],
    ['a sleep that ends before it starts', 'phone:sleep', { start: '2026-01-02T07:00:00.000Z', end: '2026-01-01T23:00:00.000Z' }],
    ['a motion with no state', 'phone:motion', { start: '2026-01-01T08:00:00.000Z' }],
    ['a motion with an unparseable start', 'phone:motion', { state: 'walking', start: 'now-ish' }],
  ])('drops %s rather than folding it', (_label, type, payload) => {
    const state = createInitialState('d1');
    const { state: next } = phoneTrack(state, ev(type, payload));
    expect(next.coverage).toEqual(state.coverage);
  });

  it('stamps the event time when the phone sends an empty arrival, and reads a departure from the key', () => {
    const state = createInitialState('test-device');
    const arrive = phoneTrack(state, { id: 'a', type: 'phone:place', ts: '2026-09-04T09:40:45.000Z', payload: { label: 'office', arrival: '' }, sanitized: true } as never).state;
    expect(arrive.coverage.place).toBe('office');
    expect(arrive.coverage.placeSince).toBe('2026-09-04T09:40:45.000Z');
    const leave = phoneTrack(arrive, { id: 'b', type: 'phone:place', ts: '2026-09-04T17:02:00.000Z', payload: { label: 'office', arrival: '', departure: '' }, sanitized: true } as never).state;
    expect(leave.coverage.place).toBeNull();
  });

  it('still drops a place with no label', () => {
    const state = createInitialState('test-device');
    const out = phoneTrack(state, { id: 'c', type: 'phone:place', ts: '2026-09-04T09:00:34.000Z', payload: { label: '', arrival: '' }, sanitized: true } as never);
    expect(out.state).toBe(state);
  });
});
