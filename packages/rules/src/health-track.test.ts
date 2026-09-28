import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { healthTrack } from './health-track.js';

const ev = (type: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: 'e', type, ts: '2026-09-22T06:30:00.000Z', payload, sanitized: true });

describe('healthTrack (J3.1)', () => {
  it('files last night as hours and a span; a resting heart rate; steps — and drops what is malformed', () => {
    let state = createInitialState('d1');
    state = healthTrack(state, ev('health:sleep', { start: '2026-09-21T23:10:00.000Z', end: '2026-09-22T06:22:00.000Z' })).state;
    expect(state.owner.energy).toMatchObject({ sleepHours: 7.2, sleptFrom: '2026-09-21T23:10:00.000Z', sleptTo: '2026-09-22T06:22:00.000Z', updatedAt: '2026-09-22T06:30:00.000Z' });
    state = healthTrack(state, ev('health:hr', { resting: 52.4 })).state;
    state = healthTrack(state, ev('health:steps', { count: 4123 })).state;
    expect(state.owner.energy).toMatchObject({ restingHr: 52, steps: 4123, sleepHours: 7.2 });
    const before = state;
    expect(healthTrack(state, ev('health:sleep', { start: '2026-09-22T06:22:00.000Z', end: '2026-09-21T23:10:00.000Z' })).state).toBe(before);
    expect(healthTrack(state, ev('health:sleep', { start: 'last night', end: '' })).state).toBe(before);
    expect(healthTrack(state, ev('health:hr', { resting: 400 })).state).toBe(before);
    // The existing "Gnomon Sleep" Shortcut posts phone:sleep; the same night lands.
    const viaPhone = healthTrack(createInitialState('d1'), ev('phone:sleep', { start: '2026-09-21T23:00:00.000Z', end: '2026-09-22T06:00:00.000Z' })).state;
    expect(viaPhone.owner.energy.sleepHours).toBe(7);
  });
});
