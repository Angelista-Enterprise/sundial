import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { memoryPriorities } from './memory-priorities.js';

function prioritiesEvent(top: unknown, ts = '2026-07-19T00:00:00.000Z'): SanitizedEvent {
  return { id: 'e1', type: 'memory:priorities', ts, payload: { top }, sanitized: true };
}

describe('memoryPriorities (D5, addresses A§5.1, A§5.5)', () => {
  it('replaces state.memory.priorities with the payload.top list', () => {
    const state = createInitialState('d1');
    const { state: next } = memoryPriorities(state, prioritiesEvent(['Code', 'Terminal', 'Chrome']));
    expect(next.memory.priorities).toEqual(['Code', 'Terminal', 'Chrome']);
  });

  it('defaults to an empty array when payload.top is missing or not an array', () => {
    const state = createInitialState('d1');
    expect(memoryPriorities(state, prioritiesEvent(undefined)).state.memory.priorities).toEqual([]);
    expect(memoryPriorities(state, prioritiesEvent('not-an-array')).state.memory.priorities).toEqual([]);
  });

  it('never emits effects — a pure state fold', () => {
    const state = createInitialState('d1');
    const { effects } = memoryPriorities(state, prioritiesEvent(['Code']));
    expect(effects).toEqual([]);
  });

  it('ignores non-memory:priorities events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = memoryPriorities(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
