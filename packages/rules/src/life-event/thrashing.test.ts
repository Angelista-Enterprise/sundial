import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { thrashing } from './thrashing.js';

function windowEvent(ts: string, processName: string): SanitizedEvent {
  return { id: 'e1', type: 'window:changed', ts, payload: { processName }, sanitized: true };
}

/** Feed a run of window events, one every `stepS` seconds, and hand back the last result. */
function run(processes: string[], stepS = 5, from = 0): { state: KernelState; effects: unknown[] } {
  let state: KernelState = createInitialState('d1');
  let effects: unknown[] = [];
  processes.forEach((process, index) => {
    const at = from + index * stepS;
    const result = thrashing(state, windowEvent(`2026-01-01T00:0${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}.000Z`, process));
    state = result.state;
    effects = result.effects;
  });
  return { state, effects };
}

/** Alternating apps, so every event after the first is a real flip. */
const alternating = (n: number): string[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'Chrome' : 'Code'));

describe('thrashing', () => {
  it('emits once nine flips BETWEEN apps land within the 90s window', () => {
    // Ten alternating events are nine transitions — one every five seconds.
    const { state, effects } = run(alternating(10));
    expect(effects).toHaveLength(1);
    expect((effects[0] as { event: { payload: unknown } }).event.payload).toMatchObject({ flips: 9, switchCount: 10, windowMs: 90_000 });
    expect(state.lifeEvent.recentSwitches).toEqual([]);
  });

  it('never calls one app re-titling itself a burst', () => {
    // **The bug this rule was fixed for.** It counted `window:changed`, which
    // fires on a title change too, and 56% of the record's 52,365 of them are
    // one app re-titling its own window — a terminal running a build, an
    // editor moving between files. 935 of the 4,932 bursts already in the log
    // involve exactly ONE process, which is not flipping between things; it is
    // the opposite.
    const { state, effects } = run(new Array(20).fill('Terminal'));
    expect(effects, 'twenty title changes in one app are not thrashing').toEqual([]);
    expect(state.lifeEvent.recentSwitches.length, 'they are still remembered, just not a burst').toBeGreaterThan(0);
  });

  it('holds its threshold above the ordinary working window', () => {
    // Measured over the live corpus: five or more real flips happens in about
    // a third of the 90-second windows that hold any flip at all. A detector
    // firing on a third of ordinary work is not detecting anything. Eight
    // flips must stay silent; nine must speak.
    expect(run(alternating(9)).effects, 'eight flips').toEqual([]);
    expect(run(alternating(10)).effects, 'nine flips').toHaveLength(1);
  });

  it('respects the 60s debounce on a second burst', () => {
    let state: KernelState = createInitialState('d1');
    // First burst: ten alternating events over 45 seconds.
    alternating(10).forEach((process, index) => {
      state = thrashing(state, windowEvent(`2026-01-01T00:00:${String(index * 5).padStart(2, '0')}.000Z`, process)).state;
    });
    // A second run 5 seconds later, well inside the debounce.
    let effects: unknown[] = [];
    alternating(12).forEach((process, index) => {
      const result = thrashing(state, windowEvent(`2026-01-01T00:00:${String(50 + index).padStart(2, '0')}.000Z`, process));
      state = result.state;
      effects = result.effects;
    });
    expect(effects).toEqual([]);
  });

  it('drops switches outside the 90s rolling window', () => {
    let state: KernelState = createInitialState('d1');
    state = thrashing(state, windowEvent('2026-01-01T00:00:00.000Z', 'Chrome')).state;
    state = thrashing(state, windowEvent('2026-01-01T00:02:00.000Z', 'Code')).state; // 120s later, first drops
    expect(state.lifeEvent.recentSwitches).toHaveLength(1);
  });

  it('keeps switchCount as the raw window events, beside the flips', () => {
    // The 4,932 rows already in the log carry `switchCount` under its old
    // meaning and no `flips` at all. Changing what `switchCount` counts would
    // have made history unreadable; adding `flips` lets a reader tell a
    // pre-fix row from a corrected one.
    const { effects } = run(['Chrome', 'Chrome', 'Code', 'Chrome', 'Code', 'Chrome', 'Code', 'Chrome', 'Code', 'Chrome', 'Code']);
    const payload = (effects[0] as { event: { payload: { switchCount: number; flips: number } } }).event.payload;
    expect(payload.switchCount, 'eleven window events').toBe(11);
    expect(payload.flips, 'nine of which changed app').toBe(9);
  });
});
