import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { memoryDecay } from './memory-decay.js';

describe('memoryDecay', () => {
  it('emits a DecayScores effect on day:boundary', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };

    const { state: next, effects } = memoryDecay(state, event);

    expect(next).toBe(state);
    expect(effects).toEqual([{ type: 'DecayScores', factor: expect.any(Number) }]);
    expect((effects[0] as any).factor).toBeGreaterThan(0);
    expect((effects[0] as any).factor).toBeLessThan(1);
  });

  it('ignores non-day:boundary events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };
    expect(memoryDecay(state, event).effects).toEqual([]);
  });

  it('C4: uses state.config.decayFactor, not a hardcoded constant', () => {
    const state = { ...createInitialState('d1'), config: { ...createInitialState('d1').config, decayFactor: 0.8 } };
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };

    const { effects } = memoryDecay(state, event);
    expect(effects).toEqual([{ type: 'DecayScores', factor: 0.8 }]);
  });
});
