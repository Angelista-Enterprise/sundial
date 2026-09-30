import { describe, it, expect } from 'vitest';
import { wakeupsOf } from '@sundial/helpers/loops.js';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent, ScheduledWakeup } from '@sundial/kernel/types.js';
import { loopTrack as wakeupTrack } from './loop-track.js';

const emitted = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'EmitEvent' }> => e.type === 'EmitEvent');

const NOW = '2026-01-01T09:00:00.000Z';

function tick(ts: string): SanitizedEvent {
  return { id: `tick-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

function scheduled(payload: Record<string, unknown>, ts = NOW): SanitizedEvent {
  return { id: `sched-${ts}`, type: 'wakeup:scheduled', ts, payload, sanitized: true };
}

function cancelled(key: string, ts = NOW): SanitizedEvent {
  return { id: `cancel-${ts}`, type: 'wakeup:cancelled', ts, payload: { key }, sanitized: true };
}

// W2 M1: an old snapshot's `wakeups.open`, hydrated into `wakeup` loops — so every case below also pins the hydrate.
function withWakeups(open: ScheduledWakeup[]): KernelState {
  return hydrateSnapshot('d1', { wakeups: { open } } as Partial<KernelState>);
}

const AT_1700 = '2026-01-01T17:00:00.000Z';
const WAKEUP: ScheduledWakeup = { key: 'check-the-deploy', at: AT_1700, reason: 'check whether the deploy went green', scheduledAt: NOW };

describe('wake-ups, a loop kind (was wakeupTrack)', () => {
  it('an old snapshot hydrates its wake-ups into loops once, and the old slice is gone', () => {
    const state = withWakeups([WAKEUP]);
    expect(wakeupsOf(state)).toEqual([WAKEUP]);
    expect('wakeups' in state).toBe(false);
    expect(state.loops.open[0]).toMatchObject({ kind: 'wakeup', subject: 'check-the-deploy', status: 'open' });
  });

  it('is never swept by the loop TTL nor matched by the watch resolver: it fires, once, when due', () => {
    const state = withWakeups([WAKEUP]);
    expect(wakeupTrack(state, tick('2026-01-01T16:00:00.000Z')).state).toBe(state);
    expect(wakeupTrack(state, { id: 'g', type: 'git:status', ts: NOW, payload: { cwd: '/x', ahead: 0 }, sanitized: true }).state).toBe(state);
  });

  it('ignores events it does not own', () => {
    const state = withWakeups([WAKEUP]);
    const { state: next, effects } = wakeupTrack(state, { id: 'e', type: 'window:changed', ts: NOW, payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('folds a scheduled wake-up into open, deriving the key from the reason', () => {
    const { state: next, effects } = wakeupTrack(createInitialState('d1'), scheduled({ at: AT_1700, reason: 'Check the deploy' }));
    expect(wakeupsOf(next)).toEqual([{ key: 'check-the-deploy', at: AT_1700, reason: 'Check the deploy', scheduledAt: NOW }]);
    // Scheduling says nothing to anybody — the notice comes when it is DUE.
    expect(effects).toEqual([]);
  });

  it('replaces rather than duplicates when the same key is rescheduled — "make it 18:00" is a correction', () => {
    const { state: next } = wakeupTrack(withWakeups([WAKEUP]), scheduled({ key: 'check-the-deploy', at: '2026-01-01T18:00:00.000Z', reason: 'check the deploy' }));
    expect(wakeupsOf(next)).toHaveLength(1);
    expect(wakeupsOf(next)[0].at).toBe('2026-01-01T18:00:00.000Z');
  });

  it('refuses a time already in the past — that is an immediate notice, not a schedule', () => {
    const state = createInitialState('d1');
    const { state: next } = wakeupTrack(state, scheduled({ at: '2026-01-01T08:00:00.000Z', reason: 'too late' }));
    expect(wakeupsOf(next)).toEqual([]);
  });

  it('refuses a time beyond the two-week horizon, where a typo is likelier than an intention', () => {
    const { state: next } = wakeupTrack(createInitialState('d1'), scheduled({ at: '2027-06-01T09:00:00.000Z', reason: 'mistyped year' }));
    expect(wakeupsOf(next)).toEqual([]);
  });

  it('ignores a schedule with no reason — a wake-up the owner cannot act on is noise', () => {
    const { state: next } = wakeupTrack(createInitialState('d1'), scheduled({ at: AT_1700, reason: '  ' }));
    expect(wakeupsOf(next)).toEqual([]);
  });

  it('keeps at most ten open, dropping the oldest', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 12; i += 1) {
      state = wakeupTrack(state, scheduled({ key: `w${i}`, at: AT_1700, reason: `reason ${i}` })).state;
    }
    expect(wakeupsOf(state)).toHaveLength(10);
    expect(wakeupsOf(state)[0].key).toBe('w2');
  });

  it('cancels by key', () => {
    const { state: next } = wakeupTrack(withWakeups([WAKEUP]), cancelled('check-the-deploy'));
    expect(wakeupsOf(next)).toEqual([]);
  });

  it('leaves state untouched when cancelling something that was never armed', () => {
    const state = withWakeups([WAKEUP]);
    const { state: next } = wakeupTrack(state, cancelled('never-set'));
    expect(next).toBe(state);
  });

  it('emits a notice candidate when the wake-up comes due, and REMOVES it so it cannot fire twice', () => {
    const { state: next, effects } = wakeupTrack(withWakeups([WAKEUP]), tick('2026-01-01T17:00:30.000Z'));

    expect(wakeupsOf(next)).toEqual([]);
    expect(effects).toHaveLength(1);
    const [candidate] = emitted(effects);
    expect(candidate.event.type).toBe('notice:candidate');
    expect(candidate.event.payload.kind).toBe('wakeup');
    expect(candidate.event.payload.observation).toBe('check whether the deploy went green');
  });

  it('carries the concrete time in the notice key, so a recurring wake-up never habituates itself silent', () => {
    const { effects } = wakeupTrack(withWakeups([WAKEUP]), tick('2026-01-01T17:00:30.000Z'));
    expect(emitted(effects)[0].event.payload.key).toBe(`wakeup:check-the-deploy:${AT_1700}`);
  });

  it('scores above the phasic threshold and the budget exemption — a requested wake-up is not a guess', () => {
    const { effects } = wakeupTrack(withWakeups([WAKEUP]), tick('2026-01-01T17:00:30.000Z'));
    const { payload } = emitted(effects)[0].event;
    expect((payload.surprise as number) * (payload.precision as number)).toBeGreaterThan(1.6);
    // Under urgentBelowMs (2h), which is what puts it on the phasic path.
    expect(payload.valueHalfLifeMs).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it('leaves a wake-up that is not yet due alone', () => {
    const state = withWakeups([WAKEUP]);
    const { state: next, effects } = wakeupTrack(state, tick('2026-01-01T16:59:00.000Z'));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('fires every due wake-up on one tick, not just the first', () => {
    const second: ScheduledWakeup = { ...WAKEUP, key: 'stand-up', reason: 'stand up and stretch' };
    const { state: next, effects } = wakeupTrack(withWakeups([WAKEUP, second]), tick('2026-01-01T17:01:00.000Z'));
    expect(effects).toHaveLength(2);
    expect(wakeupsOf(next)).toEqual([]);
  });

  it('derives the same event id when the same tick is replayed', () => {
    const first = wakeupTrack(withWakeups([WAKEUP]), tick('2026-01-01T17:00:30.000Z'));
    const second = wakeupTrack(withWakeups([WAKEUP]), tick('2026-01-01T17:00:30.000Z'));
    expect(emitted(first.effects)[0].event.id).toBe(emitted(second.effects)[0].event.id);
  });

  it('does nothing at all on a tick with an empty schedule', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = wakeupTrack(state, tick(NOW));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
