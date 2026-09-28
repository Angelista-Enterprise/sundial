import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { memoryReflection } from './memory-reflection.js';

function dayBoundary(ts: string): SanitizedEvent {
  return { id: 'e1', type: 'day:boundary', ts, payload: {}, sanitized: true };
}

describe('memoryReflection', () => {
  it('falls back to 24h before the event when there is no prior reflection', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = memoryReflection(state, dayBoundary('2026-07-18T00:00:00.000Z'));

    expect(effects).toEqual([{ type: 'RunReflection', since: '2026-07-17T00:00:00.000Z', ts: '2026-07-18T00:00:00.000Z' }]);
    expect(next.memory.lastReflectionAt).toBe('2026-07-18T00:00:00.000Z');
    expect(next.memory.accumulatedImportance).toBe(0);
  });

  it('uses the last reflection timestamp as `since` when one exists', () => {
    const state: KernelState = { ...createInitialState('d1'), memory: { ...createInitialState('d1').memory, lastReflectionAt: '2026-07-16T00:00:00.000Z', accumulatedImportance: 42 } };
    const { effects } = memoryReflection(state, dayBoundary('2026-07-18T00:00:00.000Z'));

    expect(effects).toEqual([{ type: 'RunReflection', since: '2026-07-16T00:00:00.000Z', ts: '2026-07-18T00:00:00.000Z' }]);
  });

  it('resets accumulatedImportance after firing', () => {
    const state: KernelState = { ...createInitialState('d1'), memory: { ...createInitialState('d1').memory, accumulatedImportance: 42 } };
    const { state: next } = memoryReflection(state, dayBoundary('2026-07-18T00:00:00.000Z'));
    expect(next.memory.accumulatedImportance).toBe(0);
  });

  it('ignores non-day:boundary events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = memoryReflection(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
