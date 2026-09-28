import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { dailyJournal } from './daily-journal.js';

function dayBoundary(previousDate: string, newDate: string): SanitizedEvent {
  return { id: 'e1', type: 'day:boundary', ts: `${newDate}T00:00:01.000Z`, payload: { previousDate, newDate }, sanitized: true };
}

describe('dailyJournal', () => {
  it('emits a RunJournal for the day that just ended', () => {
    const { effects } = dailyJournal(createInitialState('d1'), dayBoundary('2026-07-20', '2026-07-21'));
    expect(effects).toEqual([{ type: 'RunJournal', date: '2026-07-20', ts: '2026-07-21T00:00:01.000Z' }]);
  });

  it('ignores non day:boundary events', () => {
    const { effects } = dailyJournal(createInitialState('d1'), { id: 'e1', type: 'window:changed', ts: '2026-07-21T00:00:00.000Z', payload: {}, sanitized: true });
    expect(effects).toEqual([]);
  });

  it('does nothing without a previousDate', () => {
    const { effects } = dailyJournal(createInitialState('d1'), { id: 'e1', type: 'day:boundary', ts: '2026-07-21T00:00:00.000Z', payload: { newDate: '2026-07-21' }, sanitized: true });
    expect(effects).toEqual([]);
  });

  it('does not mutate state', () => {
    const state = createInitialState('d1');
    const { state: next } = dailyJournal(state, dayBoundary('2026-07-20', '2026-07-21'));
    expect(next).toBe(state);
  });
});
