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
    // 00:05 UTC is still the evening's waking day (from 04:00), and the first real input of it.
    expect(effects).toEqual([
      { type: 'EmitEvent', event: { id: expect.any(String), type: 'owner:first-touch', ts: tsAt(30), payload: { timestamp: tsAt(30), day: '2025-12-31' } } },
      { type: 'EmitEvent', event: { id: expect.any(String), type: 'idle:end', ts: tsAt(30), payload: { timestamp: tsAt(30) } } },
    ]);
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

describe('idleTrack: the first touch of the day', () => {
  const touches = (effects: ReturnType<typeof idleTrack>['effects']) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'owner:first-touch').map((e) => (e as { event: { ts: string; payload: Record<string, unknown> } }).event);
  const at = (iso: string, n = 1) => activityEvent(`t-${iso}`, iso, { keyDownCount: n });
  function amsterdam() {
    const state = createInitialState('d1');
    state.config.timezone = 'Europe/Amsterdam';
    return state;
  }

  it('fires once a waking day, on the first real input, not on a zero window or a second touch', () => {
    let state = amsterdam();
    const zero = idleTrack(state, activityEvent('z', '2026-11-16T08:20:00.000Z'));
    expect(touches(zero.effects)).toEqual([]);
    state = zero.state;
    const first = idleTrack(state, at('2026-11-16T08:27:00.000Z'));
    expect(touches(first.effects)).toEqual([{ id: expect.any(String), type: 'owner:first-touch', ts: '2026-11-16T08:27:00.000Z', payload: { timestamp: '2026-11-16T08:27:00.000Z', day: '2026-11-16' } }]);
    expect(first.state.lifeEvent.idle.firstTouchDay).toBe('2026-11-16');
    expect(touches(idleTrack(first.state, at('2026-11-16T09:00:00.000Z')).effects), 'the same day again').toEqual([]);
    expect(touches(idleTrack(first.state, at('2026-11-16T23:30:00.000Z')).effects), '00:30 local is still that day').toEqual([]);
    expect(touches(idleTrack(first.state, at('2026-11-17T07:10:00.000Z')).effects).map((e) => e.payload.day), 'the next morning').toEqual(['2026-11-17']);
  });

  it('never on input Gnomon caused (the byGnomon mark)', () => {
    const state = amsterdam();
    const event = at('2026-11-16T08:27:00.000Z');
    state.byGnomon = { ...state.byGnomon, marked: { id: event.id, why: 'act' } };
    const out = idleTrack(state, event);
    expect(touches(out.effects)).toEqual([]);
    expect(out.state.lifeEvent.idle.firstTouchDay ?? null).toBeNull();
    expect(touches(idleTrack(out.state, at('2026-11-16T08:29:00.000Z')).effects), 'the owner\'s own input after it is the first touch').toHaveLength(1);
  });

  it('a snapshot from before the field, with input already today, does not fire mid-day', () => {
    const state = amsterdam();
    state.lifeEvent.idle.lastActiveAt = '2026-11-16T11:00:00.000Z';
    expect(touches(idleTrack(state, at('2026-11-16T11:05:00.000Z')).effects)).toEqual([]);
  });
});

describe('ownerHandAt (Set 2 R4: the owner\'s hand wins)', () => {
  it('the end of the last window with an owner key or click; a move or scroll, a zero window, or a window Gnomon marked keeps the old one', () => {
    let state = createInitialState('d1');
    state = idleTrack(state, activityEvent('h1', tsAt(1), { keyDownCount: 2 })).state;
    expect(state.lifeEvent.idle.ownerHandAt).toBe(tsAt(1));
    state = idleTrack(state, activityEvent('h2', tsAt(2), { mouseClickCount: 1 })).state;
    expect(state.lifeEvent.idle.ownerHandAt).toBe(tsAt(2));
    state = idleTrack(state, activityEvent('h3', tsAt(3), { mouseMoveCount: 40, scrollCount: 3 })).state;
    state = idleTrack(state, activityEvent('h4', tsAt(4))).state;
    expect(state.lifeEvent.idle.ownerHandAt).toBe(tsAt(2));
    const gnomons = activityEvent('h5', tsAt(5), { keyDownCount: 9 });
    state = idleTrack({ ...state, byGnomon: { ...state.byGnomon, marked: { id: 'h5', why: 'act' } } }, gnomons).state;
    expect(state.lifeEvent.idle.ownerHandAt).toBe(tsAt(2));
  });

  // Set 2 R5: a helper that writes the hardware-only times.
  it('from a hardware-only helper: the newest key or click time, kept when older, and a marked window still counts', () => {
    const owned = (id: string, n: number, extra: Record<string, unknown>): SanitizedEvent => ({ ...activityEvent(id, tsAt(n), { keyDownCount: 3 }), payload: { keyDownCount: 3, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, ownerOnly: true, ...extra } });
    const key = new Date(Date.parse(tsAt(1)) - 7_000).toISOString();
    const click = new Date(Date.parse(tsAt(1)) - 2_500).toISOString();
    let state = idleTrack(createInitialState('d1'), owned('o1', 1, { lastKeyAt: key, lastClickAt: click })).state;
    expect(state.lifeEvent.idle.ownerHandAt, 'the keystroke time, not the window end').toBe(click);
    state = idleTrack(state, owned('o2', 2, {})).state;
    expect(state.lifeEvent.idle.ownerHandAt, 'Gnomon typed, the owner did not: no hardware time').toBe(click);
    state = idleTrack(state, owned('o3', 3, { lastKeyAt: key })).state;
    expect(state.lifeEvent.idle.ownerHandAt, 'an older time never moves it back').toBe(click);
    const later = new Date(Date.parse(tsAt(4)) - 1_000).toISOString();
    state = idleTrack({ ...state, byGnomon: { ...state.byGnomon, marked: { id: 'o4', why: 'act' } } }, owned('o4', 4, { lastKeyAt: later })).state;
    expect(state.lifeEvent.idle.ownerHandAt, 'the owner typed during an act').toBe(later);
  });
});
