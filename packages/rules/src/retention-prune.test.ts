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
    expect(effects).toHaveLength(7);
    expect(effects[1]).toEqual({ type: 'DeleteRows', olderThan: '2026-07-03T00:00:00.000Z', signalTypes: ['screen'] });
  });

  it('prunes the chat log on the prompt-body horizon (W1)', () => {
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    expect(retentionPrune(createInitialState('d1'), event).effects).toContainEqual({ type: 'DeleteRows', olderThan: '2026-06-17T00:00:00.000Z', signalTypes: ['chat'] });
    expect(retentionPrune(createInitialState('d1'), event).effects).toContainEqual({ type: 'DeleteRows', olderThan: '2026-06-17T00:00:00.000Z', signalTypes: ['judgement'], eventTypes: ['consulted'] });
  });

  it('skips the screen sweep when it would not be shorter than the general prune', () => {
    const base = createInitialState('d1');
    const state = { ...base, config: { ...base.config, retentionDays: 10, screenTextRetentionDays: 14 } };
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    expect(retentionPrune(state, event).effects.filter((e) => e.type === 'DeleteRows' && !e.apps && !e.trim && !e.signalTypes?.includes('chat') && !e.signalTypes?.includes('judgement'))).toHaveLength(1);
  });

  it('sweeps transcripts on audio.retentionDays, leaving the headphone rows', () => {
    const base = createInitialState('d1');
    const state = { ...base, config: { ...base.config, transcriptRetentionDays: 7 } };
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    expect(retentionPrune(state, event).effects).toContainEqual({ type: 'DeleteRows', olderThan: '2026-07-10T00:00:00.000Z', signalTypes: ['audio'], eventTypes: ['transcript'] });
  });

  it('purges screens of strictly sensitive apps whatever their age, the system password dialog included', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    const purge = retentionPrune(state, event).effects.find((e) => e.type === 'DeleteRows' && e.apps);
    expect(purge).toMatchObject({ olderThan: '2026-07-17T00:00:00.000Z', signalTypes: ['screen'] });
    expect(purge?.type === 'DeleteRows' && purge.apps).toEqual(expect.arrayContaining(['passwords', 'keychain', 'securityagent', 'loginwindow']));
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

describe('LLM text and the effect journal go after 30 days (Q10)', () => {
  it('asks for the trim at 30 days, or the general horizon when that is shorter', () => {
    const event: SanitizedEvent = { id: 'e1', type: 'day:boundary', ts: '2026-07-17T00:00:00.000Z', payload: {}, sanitized: true };
    expect(retentionPrune(createInitialState('d1'), event).effects).toContainEqual({ type: 'DeleteRows', olderThan: '2026-06-17T00:00:00.000Z', trim: 'audit-bodies' });
    const base = createInitialState('d1');
    const short = { ...base, config: { ...base.config, retentionDays: 10 } };
    expect(retentionPrune(short, event).effects).toContainEqual({ type: 'DeleteRows', olderThan: '2026-07-07T00:00:00.000Z', trim: 'audit-bodies' });
  });
});
