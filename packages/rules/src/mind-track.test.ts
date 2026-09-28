import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { mindTrack, circadianPhase, moodFor } from './mind-track.js';

function tick(ts: string): SanitizedEvent {
  return { id: 't1', type: 'clock:tick', ts, payload: {}, sanitized: true };
}
function withDrive(v: number): KernelState {
  const base = createInitialState('d1');
  return { ...base, memory: { ...base.memory, accumulatedImportance: v } };
}

describe('circadianPhase (pure, TZ-independent)', () => {
  it('maps hours to phases at the boundaries', () => {
    expect(circadianPhase(0)).toBe('night');
    expect(circadianPhase(5)).toBe('night');
    expect(circadianPhase(6)).toBe('day');
    expect(circadianPhase(17)).toBe('day');
    expect(circadianPhase(18)).toBe('evening');
    expect(circadianPhase(21)).toBe('evening');
    expect(circadianPhase(22)).toBe('night');
    expect(circadianPhase(23)).toBe('night');
  });
});

describe('moodFor (pure)', () => {
  it('buckets the drive into settled / stirring / restless', () => {
    expect(moodFor(0)).toBe('settled');
    expect(moodFor(4)).toBe('settled');
    expect(moodFor(5)).toBe('stirring');
    expect(moodFor(14)).toBe('stirring');
    expect(moodFor(15)).toBe('restless');
    expect(moodFor(60)).toBe('restless');
  });
});

describe('mindTrack', () => {
  it('sets mood from the drive on a clock:tick', () => {
    const { state: next } = mindTrack(withDrive(20), tick('2026-07-18T10:00:00.000Z'));
    expect(next.mind.mood).toBe('restless');
  });

  it('sets circadian to circadianPhase(local hour) of the tick', () => {
    const ts = '2026-07-18T10:00:00.000Z';
    const { state: next } = mindTrack(withDrive(20), tick(ts));
    expect(next.mind.circadian).toBe(circadianPhase(new Date(ts).getHours()));
  });

  it('returns state unchanged when neither circadian nor mood moved', () => {
    // default state: mood 'settled', circadian 'day'; a daytime tick with zero drive changes nothing
    const base = createInitialState('d1');
    const localDayTs = new Date(2026, 6, 18, 10, 0, 0).toISOString(); // local 10:00 → 'day'
    const { state: next, effects } = mindTrack(base, tick(localDayTs));
    expect(next).toBe(base);
    expect(effects).toEqual([]);
  });

  it('never writes the drive itself (readout only)', () => {
    const { state: next } = mindTrack(withDrive(20), tick('2026-07-18T10:00:00.000Z'));
    expect(next.memory.accumulatedImportance).toBe(20);
  });

  it('ignores non-clock:tick events', () => {
    const state = withDrive(20);
    const ev: SanitizedEvent = { id: 'e1', type: 'anomaly:detected', ts: '2026-07-18T10:00:00.000Z', payload: {}, sanitized: true };
    expect(mindTrack(state, ev).state).toBe(state);
  });
});
