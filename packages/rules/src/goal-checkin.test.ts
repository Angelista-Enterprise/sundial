import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { goalCheckin, goalLabel, goalProgressTrack, openGoals, weekProgress } from './goal-checkin.js';

const progress = (goalId: string, momentId: string, ts: string, minutes = 30): SanitizedEvent => ({ id: `e-${momentId}`, type: 'goal:progress', ts, payload: { goalId, momentId, p: 0.8, minutes }, sanitized: true });

describe('J2.7 goal progress', () => {
  it('goalLabel keeps the owner\'s words off a status and drops a bare status word', () => {
    expect(goalLabel({ name: 'strip auth tokens', status: 'open — query params are saved verbatim' })).toBe('strip auth tokens — query params are saved verbatim');
    expect(goalLabel({ name: 'demo the changes', status: 'open' })).toBe('demo the changes');
    expect(goalLabel({ name: 'sleep rhythm', status: 'Bring the bedtime in check' })).toBe('sleep rhythm — Bring the bedtime in check');
  });

  it('goalProgressTrack files one entry per moment per goal, bounded, and ignores a malformed payload', () => {
    let state = createInitialState('d1');
    state = goalProgressTrack(state, progress('goal:a', 'm1', '2026-09-22T10:00:00.000Z')).state;
    state = goalProgressTrack(state, progress('goal:a', 'm1', '2026-09-22T10:00:00.000Z')).state;
    state = goalProgressTrack(state, progress('goal:a', 'm2', '2026-09-22T11:00:00.000Z', 45)).state;
    expect(state.goals.progress['goal:a']).toEqual([
      { momentId: 'm1', ts: '2026-09-22T10:00:00.000Z', p: 0.8, minutes: 30 },
      { momentId: 'm2', ts: '2026-09-22T11:00:00.000Z', p: 0.8, minutes: 45 },
    ]);
    for (let i = 0; i < 30; i += 1) state = goalProgressTrack(state, progress('goal:a', `x${i}`, '2026-09-22T12:00:00.000Z')).state;
    expect(state.goals.progress['goal:a']).toHaveLength(20);
    const bad = goalProgressTrack(state, { ...progress('goal:a', 'm9', '2026-09-22T12:00:00.000Z'), payload: { goalId: 'goal:a' } });
    expect(bad.state).toBe(state);
  });

  it('openGoals reads "done — <note>" as done', () => {
    expect(openGoals({ 'goal:a:status': { object: 'done — easy to toggle' }, 'goal:b:status': { object: 'open — details' }, 'goal:c:status': { object: 'Bring the bedtime in check' } }).map((g) => g.entityId)).toEqual(['goal:b', 'goal:c']);
  });

  it('weekProgress counts only the last seven days', () => {
    const entries = [
      { momentId: 'old', ts: '2026-09-10T10:00:00.000Z', p: 0.9, minutes: 60 },
      { momentId: 'new', ts: '2026-09-21T10:00:00.000Z', p: 0.7, minutes: 25 },
    ];
    expect(weekProgress(entries, '2026-09-22T00:00:00.000Z')).toEqual({ sessions: 1, minutes: 25, momentIds: ['new'] });
    expect(weekProgress(undefined, '2026-09-22T00:00:00.000Z')).toEqual({ sessions: 0, minutes: 0, momentIds: [] });
  });

  it('the Monday check-in cites the week\'s sessions per goal and carries the moments as evidence', () => {
    let state = createInitialState('d1');
    state = { ...state, config: { ...state.config, timezone: 'Europe/Amsterdam' }, memory: { ...state.memory, factCursor: { 'goal:a:status': { object: 'open' }, 'goal:b:status': { object: 'open — details' }, 'goal:c:status': { object: 'done' } } as never } };
    state = goalProgressTrack(state, progress('goal:a', 'm1', '2026-09-25T10:00:00.000Z', 90)).state;
    state = goalProgressTrack(state, progress('goal:a', 'm2', '2026-09-26T10:00:00.000Z', 40)).state;
    // 2026-09-28 is a Monday; the boundary fires at local midnight.
    const { effects } = goalCheckin(state, { id: 'b', type: 'day:boundary', ts: '2026-09-27T22:00:00.000Z', payload: {}, sanitized: true });
    expect(effects).toHaveLength(1);
    const payload = (effects[0] as { event: { payload: Record<string, unknown> } }).event.payload;
    expect(payload.question).toBe('New week. Your open goals: a (2 sessions, 2 h); b (no time seen). Which got real time last week, and should any be paused or dropped?');
    expect(payload.evidence).toEqual({ 'goal:a': ['m1', 'm2'] });
  });
});
