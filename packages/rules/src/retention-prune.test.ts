import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { retentionPrune } from './retention-prune.js';

describe('retentionPrune', () => {
  it('emits a DeleteRows effect with a cutoff 180 days before day:boundary', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };

    const { state: next, effects } = retentionPrune(state, event);

    expect(next.retention).toEqual({ lastPrunedAt: '2026-07-17T00:00:00.000Z' });
    expect(effects[0]).toEqual({ type: 'DeleteRows', olderThan: '2026-01-18T00:00:00.000Z' });
  });

  it('sweeps raw screen text on its own, shorter horizon (14 days by default)', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    const { effects } = retentionPrune(state, event);
    expect(effects).toHaveLength(2);
    expect(effects[1]).toEqual({ type: 'DeleteRows', olderThan: '2026-07-03T00:00:00.000Z', signalTypes: ['screen'] });
  });

  it('skips the screen sweep when it would not be shorter than the general prune', () => {
    const base = createInitialState('d1');
    const state = { ...base, config: { ...base.config, retentionDays: 10, screenTextRetentionDays: 14 } };
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    expect(retentionPrune(state, event).effects).toHaveLength(1);
  });

  it('ignores non-day:boundary events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    const { effects } = retentionPrune(state, event);
    expect(effects).toEqual([]);
  });

  it('C4: uses state.config.retentionDays, not a hardcoded constant', () => {
    const state = { ...createInitialState('d1'), config: { ...createInitialState('d1').config, retentionDays: 30 } };
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };

    const { effects } = retentionPrune(state, event);
    expect(effects[0]).toEqual({ type: 'DeleteRows', olderThan: '2026-06-17T00:00:00.000Z' });
  });
});
