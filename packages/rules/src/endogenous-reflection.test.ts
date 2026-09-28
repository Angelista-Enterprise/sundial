import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { endogenousReflection } from './endogenous-reflection.js';

function tick(ts: string): SanitizedEvent {
  return { id: 't1', type: 'clock:tick', ts, payload: {}, sanitized: true };
}
function stateWith(opts: { drive?: number; idle?: boolean; lastEndo?: string | null; lastRefl?: string | null }): KernelState {
  const base = createInitialState('d1');
  return {
    ...base,
    memory: { ...base.memory, accumulatedImportance: opts.drive ?? 0, lastReflectionAt: opts.lastRefl ?? null },
    mind: { ...base.mind, lastEndogenousReflectionAt: opts.lastEndo ?? null },
    lifeEvent: { ...base.lifeEvent, idle: { consecutiveZeroWindows: 40, isIdle: opts.idle ?? false } },
  };
}

describe('endogenousReflection', () => {
  it('fires RunReflection(endogenous) when drive is high AND the user is idle', () => {
    const s = stateWith({ drive: 20, idle: true, lastRefl: '2026-07-18T06:00:00.000Z' });
    const { state: next, effects } = endogenousReflection(s, tick('2026-07-18T12:00:00.000Z'));
    expect(effects).toEqual([{ type: 'RunReflection', since: '2026-07-18T06:00:00.000Z', ts: '2026-07-18T12:00:00.000Z', reason: 'endogenous' }]);
    expect(next.memory.accumulatedImportance).toBe(0);
    expect(next.memory.lastReflectionAt).toBe('2026-07-18T12:00:00.000Z');
    expect(next.mind.lastEndogenousReflectionAt).toBe('2026-07-18T12:00:00.000Z');
  });

  it('does not fire while the user is active (not idle) — never interrupts', () => {
    const s = stateWith({ drive: 20, idle: false });
    const { state: next, effects } = endogenousReflection(s, tick('2026-07-18T12:00:00.000Z'));
    expect(effects).toEqual([]);
    expect(next).toBe(s);
  });

  it('does not fire below the drive threshold', () => {
    const s = stateWith({ drive: 10, idle: true });
    expect(endogenousReflection(s, tick('2026-07-18T12:00:00.000Z')).effects).toEqual([]);
  });

  it('rate-limits to at most once per 3h', () => {
    const s = stateWith({ drive: 20, idle: true, lastEndo: '2026-07-18T11:00:00.000Z' }); // 1h ago
    expect(endogenousReflection(s, tick('2026-07-18T12:00:00.000Z')).effects).toEqual([]);
  });

  it('fires again once the interval has elapsed', () => {
    const s = stateWith({ drive: 20, idle: true, lastEndo: '2026-07-18T08:00:00.000Z', lastRefl: '2026-07-18T08:00:00.000Z' }); // 4h ago
    expect(endogenousReflection(s, tick('2026-07-18T12:00:00.000Z')).effects).toHaveLength(1);
  });

  it('falls back to 24h-before when there is no prior reflection', () => {
    const s = stateWith({ drive: 20, idle: true, lastRefl: null });
    const { effects } = endogenousReflection(s, tick('2026-07-18T12:00:00.000Z'));
    expect(effects[0]).toMatchObject({ type: 'RunReflection', since: '2026-07-17T12:00:00.000Z', reason: 'endogenous' });
  });

  it('ignores non-clock:tick events', () => {
    const s = stateWith({ drive: 20, idle: true });
    const ev: SanitizedEvent = { id: 'e', type: 'day:boundary', ts: '2026-07-18T12:00:00.000Z', payload: {}, sanitized: true };
    expect(endogenousReflection(s, ev).state).toBe(s);
  });
});
