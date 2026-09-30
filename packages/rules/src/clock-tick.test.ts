import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { clockTick } from './clock-tick.js';

function tick(ts: string): SanitizedEvent {
  return { id: `e-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

/** State whose day-tracking starts on `day`, in `timezone`. */
function at(day: string, timezone: string): KernelState {
  const base = createInitialState('d1');
  return { ...base, config: { ...base.config, timezone }, budgets: { ...base.budgets, day } };
}

/** The emitted `day:boundary`, or null when the tick produced none. */
function boundaryOf(result: ReturnType<typeof clockTick>): { previousDate: string; newDate: string } | null {
  const emit = result.effects.find((e) => (e as { type: string }).type === 'EmitEvent') as { event: { payload: Record<string, string> } } | undefined;
  return emit ? (emit.event.payload as { previousDate: string; newDate: string }) : null;
}

describe('clockTick', () => {
  it('ignores events other than clock:tick', () => {
    const state = at('2026-07-29', 'UTC');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-07-29T12:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = clockTick(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('learns the day on the first tick of a fresh state, without a boundary for a day that never ran', () => {
    const { state: next, effects } = clockTick(at('', 'Europe/Amsterdam'), tick('2026-07-24T07:00:00.000Z'));
    expect(effects).toEqual([]);
    expect(next.budgets.day).toBe('2026-07-24');
  });

  it('emits nothing while the day has not turned over', () => {
    const { effects } = clockTick(at('2026-07-29', 'UTC'), tick('2026-07-29T12:00:00.000Z'));
    expect(effects).toEqual([]);
  });

  /**
   * The C21 defect. `ts.slice(0, 10)` made a day a UTC day, so in Amsterdam the
   * boundary landed at 02:00 local and everything keyed off it — the daily journal,
   * per-day budgets, decay, retention — used a 02:00-to-02:00 window. Measured
   * cost on the real corpus: 103 of 3,577 moments (2.9%) carried a UTC date
   * different from their local one.
   */
  describe('the day turns over in the owner timezone', () => {
    it('rolls at local midnight, which is 22:00Z in Amsterdam summer', () => {
      // 21:59Z is still 23:59 local on the 29th — no boundary yet.
      expect(boundaryOf(clockTick(at('2026-07-29', 'Europe/Amsterdam'), tick('2026-07-29T21:59:00.000Z')))).toBeNull();
      // 22:00Z is 00:00 local on the 30th.
      expect(boundaryOf(clockTick(at('2026-07-29', 'Europe/Amsterdam'), tick('2026-07-29T22:00:00.000Z')))).toEqual({
        previousDate: '2026-07-29',
        newDate: '2026-07-30',
      });
    });

    it('does NOT roll at UTC midnight, which is 02:00 local', () => {
      // The old behaviour would have turned the day over here.
      const state = at('2026-07-30', 'Europe/Amsterdam');
      expect(boundaryOf(clockTick(state, tick('2026-07-30T00:00:30.000Z')))).toBeNull();
    });

    it('rolls at 23:00Z in winter, when the offset is +1', () => {
      expect(boundaryOf(clockTick(at('2026-01-15', 'Europe/Amsterdam'), tick('2026-01-15T22:59:00.000Z')))).toBeNull();
      expect(boundaryOf(clockTick(at('2026-01-15', 'Europe/Amsterdam'), tick('2026-01-15T23:00:00.000Z')))?.newDate).toBe('2026-01-16');
    });

    it('rolls a zone behind UTC on its own schedule', () => {
      // 04:00Z is midnight in New York (UTC-4 in July).
      expect(boundaryOf(clockTick(at('2026-07-29', 'America/New_York'), tick('2026-07-30T03:59:00.000Z')))).toBeNull();
      expect(boundaryOf(clockTick(at('2026-07-29', 'America/New_York'), tick('2026-07-30T04:00:00.000Z')))?.newDate).toBe('2026-07-30');
    });

    it('still behaves as before for a UTC-configured owner', () => {
      expect(boundaryOf(clockTick(at('2026-07-29', 'UTC'), tick('2026-07-30T00:00:00.000Z')))?.newDate).toBe('2026-07-30');
    });
  });

  it('resets every per-purpose budget when the day turns', () => {
    const base = at('2026-07-29', 'Europe/Amsterdam');
    const spent: KernelState = { ...base, budgets: { ...base.budgets, byPurpose: { ...base.budgets.byPurpose, intent: { callsToday: 117 } } } };
    const { state: next } = clockTick(spent, tick('2026-07-29T22:00:00.000Z'));
    expect(next.budgets.day).toBe('2026-07-30');
    expect(next.budgets.byPurpose.intent.callsToday).toBe(0);
  });
});
