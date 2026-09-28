import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { surpriseDrive } from './surprise-drive.js';

function anomaly(zScore: unknown): SanitizedEvent {
  return { id: 'a1', type: 'anomaly:detected', ts: '2026-07-18T10:00:00.000Z', payload: { zScore }, sanitized: true } as SanitizedEvent;
}
function withDrive(v: number): KernelState {
  const base = createInitialState('d1');
  return { ...base, memory: { ...base.memory, accumulatedImportance: v } };
}

describe('surpriseDrive', () => {
  it('accumulates min(|z|, cap) into accumulatedImportance', () => {
    const { state: next } = surpriseDrive(createInitialState('d1'), anomaly(3));
    expect(next.memory.accumulatedImportance).toBe(3);
  });

  it('caps a single anomaly contribution at 5', () => {
    const { state: next } = surpriseDrive(createInitialState('d1'), anomaly(12));
    expect(next.memory.accumulatedImportance).toBe(5);
  });

  it('uses absolute value so low-activity anomalies count too', () => {
    const { state: next } = surpriseDrive(createInitialState('d1'), anomaly(-4));
    expect(next.memory.accumulatedImportance).toBe(4);
  });

  it('adds to an existing drive value', () => {
    const { state: next } = surpriseDrive(withDrive(10), anomaly(3));
    expect(next.memory.accumulatedImportance).toBe(13);
  });

  it('clamps the accumulator to MAX_ACCUMULATED (60)', () => {
    const { state: next } = surpriseDrive(withDrive(58), anomaly(5));
    expect(next.memory.accumulatedImportance).toBe(60);
  });

  it('ignores a missing / non-numeric zScore (no change)', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = surpriseDrive(state, anomaly(undefined));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('ignores non-anomaly events', () => {
    const state = createInitialState('d1');
    const ev: SanitizedEvent = { id: 'e1', type: 'clock:tick', ts: '2026-07-18T10:00:00.000Z', payload: {}, sanitized: true };
    expect(surpriseDrive(state, ev).state).toBe(state);
  });
});
