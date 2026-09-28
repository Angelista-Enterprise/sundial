import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { factConfidenceDecay } from './fact-confidence-decay.js';

describe('factConfidenceDecay', () => {
  it('emits DecayFactConfidence on day:boundary', () => {
    const ev: SanitizedEvent = { id: 'e', type: 'day:boundary', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };
    const { effects } = factConfidenceDecay(createInitialState('d1'), ev);
    expect(effects).toEqual([{ type: 'DecayFactConfidence', factor: 0.98, ts: '2026-07-18T00:00:00.000Z' }]);
  });

  it('ignores non-day:boundary events', () => {
    const state = createInitialState('d1');
    const ev: SanitizedEvent = { id: 'e', type: 'clock:tick', ts: '2026-07-18T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = factConfidenceDecay(state, ev);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
