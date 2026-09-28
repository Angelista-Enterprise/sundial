import { describe, it, expect } from 'vitest';
import { DEFAULT_DAILY_CAPS } from '@sundial/kernel/budgets.js';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { budgetTrack } from './budget-track.js';

function dispatchedEvent(purpose: string): SanitizedEvent {
  return { id: 'e1', type: 'llm:dispatched', ts: '2026-01-01T00:00:00.000Z', payload: { purpose }, sanitized: true };
}

function refundedEvent(purpose: string): SanitizedEvent {
  return { id: 'e2', type: 'llm:refunded', ts: '2026-01-01T00:00:00.000Z', payload: { purpose }, sanitized: true };
}

describe('budgetTrack', () => {
  it('increments callsToday for the dispatched purpose only', () => {
    const state = createInitialState('d1');
    const { state: next } = budgetTrack(state, dispatchedEvent('intent'));

    expect(next.budgets.byPurpose.intent.callsToday).toBe(1);
    expect(next.budgets.byPurpose.companion.callsToday).toBe(0);
  });

  // The log outlives the enum: `narrate` and `knowledge` dispatch events are
  // still in it after those purposes were retired, and a full replay must not
  // die on them.
  it('ignores a dispatch for a purpose the state no longer tracks', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = budgetTrack(state, dispatchedEvent('narrate' as never));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  // Jev's seven purposes (docs/jarvis/02) count and refund like the text
  // model's, each in its own slot, and each has a cap on the day.
  it('tracks every judgement purpose in its own slot, with a cap for each', () => {
    const purposes = ['perceive', 'classify', 'rank', 'judge', 'audit', 'forecast', 'listen'] as const;
    let state = createInitialState('d1');
    for (const purpose of purposes) state = budgetTrack(state, dispatchedEvent(purpose)).state;
    for (const purpose of purposes) {
      expect(state.budgets.byPurpose[purpose].callsToday).toBe(1);
      expect(DEFAULT_DAILY_CAPS[purpose]).toBeGreaterThan(0);
      expect(Number.isFinite(DEFAULT_DAILY_CAPS[purpose])).toBe(true);
    }
    expect(state.budgets.byPurpose.intent.callsToday).toBe(0);
    expect(budgetTrack(state, refundedEvent('judge')).state.budgets.byPurpose.judge.callsToday).toBe(0);
    expect(DEFAULT_DAILY_CAPS).toMatchObject({ perceive: 5000, classify: 3000, rank: 2000, judge: 3000, audit: 1000, forecast: 1000, listen: 200 });
  });

  it('accumulates across repeated dispatches', () => {
    let state = createInitialState('d1');
    state = budgetTrack(state, dispatchedEvent('reflect')).state;
    state = budgetTrack(state, dispatchedEvent('reflect')).state;
    state = budgetTrack(state, dispatchedEvent('reflect')).state;

    expect(state.budgets.byPurpose.reflect.callsToday).toBe(3);
  });

  it('produces no effects', () => {
    const state = createInitialState('d1');
    const { effects } = budgetTrack(state, dispatchedEvent('companion'));
    expect(effects).toEqual([]);
  });

  it('refunds a slot on llm:refunded (a no-op detached call), flooring at 0', () => {
    let state = createInitialState('d1');
    state = budgetTrack(state, dispatchedEvent('journal')).state;
    state = budgetTrack(state, dispatchedEvent('journal')).state;
    expect(state.budgets.byPurpose.journal.callsToday).toBe(2);

    state = budgetTrack(state, refundedEvent('journal')).state;
    expect(state.budgets.byPurpose.journal.callsToday).toBe(1);

    // never goes negative even if refunds outnumber spends
    state = budgetTrack(state, refundedEvent('journal')).state;
    state = budgetTrack(state, refundedEvent('journal')).state;
    expect(state.budgets.byPurpose.journal.callsToday).toBe(0);
  });

  it('ignores non-llm:dispatched events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = budgetTrack(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
