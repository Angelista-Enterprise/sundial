import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { coverageBucket, EMITS_PER_FULL_HOUR } from './coverage-track.js';
import { assessNovelty, MIN_OBSERVED_HOURS } from './llm-novelty-gate.js';
import { dailyJournal } from './daily-journal.js';
import { nightlyFactExtract } from './nightly-fact-extract.js';

/** Marks `[fromIso, toIso)` as fully watched, at a chosen fraction of a full hour. */
function watched(state: KernelState, fromIso: string, toIso: string, fraction = 1): KernelState {
  const observedHours = { ...state.coverage.observedHours };
  for (let cursor = Date.parse(fromIso); cursor < Date.parse(toIso); cursor += 3_600_000) {
    observedHours[coverageBucket(new Date(cursor).toISOString(), state.config.timezone)] = Math.round(EMITS_PER_FULL_HOUR * fraction);
  }
  return { ...state, coverage: { ...state.coverage, observedHours } };
}

const boundary = (ts: string, previousDate: string): SanitizedEvent => ({ id: 'b1', type: 'day:boundary', ts, payload: { previousDate }, sanitized: true });

describe('assessNovelty', () => {
  it('calls when the window was properly watched', () => {
    const state = watched(createInitialState('d1'), '2026-08-13T09:00:00.000Z', '2026-08-13T17:00:00.000Z');
    const verdict = assessNovelty(state, '2026-08-13T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

    expect(verdict.worthCalling).toBe(true);
    expect(verdict.observedHours).toBeGreaterThan(MIN_OBSERVED_HOURS);
  });

  it('skips when the daemon saw almost nothing', () => {
    const state = watched(createInitialState('d1'), '2026-08-13T09:00:00.000Z', '2026-08-13T10:00:00.000Z', 0.2);
    const verdict = assessNovelty(state, '2026-08-13T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

    expect(verdict.worthCalling).toBe(false);
    expect(verdict.reason).toBe('too-little-observed');
  });

  it('fails OPEN when there is no coverage record at all', () => {
    // Absence of evidence is not evidence of an empty day. A missing map must never
    // silently stop the daemon writing anything down.
    const verdict = assessNovelty(createInitialState('d1'), '2026-08-13T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    expect(verdict.worthCalling).toBe(true);
    expect(verdict.reason).toBe('no-coverage-record');
  });

  it('runs anyway once a deferred window grows past the ceiling', () => {
    // Otherwise an unobserved fortnight defers for ever and the eventual prompt is
    // unbounded — a saving that turns into a cost.
    const state = watched(createInitialState('d1'), '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', 0.1);
    const verdict = assessNovelty(state, '2026-08-01T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    expect(verdict.worthCalling).toBe(true);
  });
});

describe('the gate in the rules that spend', () => {
  it('dailyJournal skips a barely-observed day and says so in the log', () => {
    const state = watched(createInitialState('d1'), '2026-08-13T09:00:00.000Z', '2026-08-13T10:00:00.000Z', 0.1);
    const { effects } = dailyJournal(state, boundary('2026-08-14T00:05:00.000Z', '2026-08-13'));

    expect(effects.find((e: any) => e.type === 'RunJournal')).toBeUndefined();
    const skipped = effects.find((e: any) => e.type === 'EmitEvent') as any;
    expect(skipped.event.type).toBe('llm:skipped');
    expect(skipped.event.payload.purpose).toBe('journal');
  });

  it('dailyJournal still runs on a real day', () => {
    const state = watched(createInitialState('d1'), '2026-08-13T08:00:00.000Z', '2026-08-13T18:00:00.000Z');
    const { effects } = dailyJournal(state, boundary('2026-08-14T00:05:00.000Z', '2026-08-13'));
    expect(effects.find((e: any) => e.type === 'RunJournal')).toBeDefined();
  });

  it('nightlyFactExtract does NOT advance its cursor when it skips', () => {
    // The skipped window has to roll into the next pass rather than be lost.
    let state = watched(createInitialState('d1'), '2026-08-13T09:00:00.000Z', '2026-08-13T10:00:00.000Z', 0.1);
    state = { ...state, memory: { ...state.memory, lastFactExtractAt: '2026-08-13T00:00:00.000Z' } };

    const { state: next, effects } = nightlyFactExtract(state, boundary('2026-08-14T00:05:00.000Z', '2026-08-13'));

    expect(effects.find((e: any) => e.type === 'RunFactExtraction')).toBeUndefined();
    expect(next.memory.lastFactExtractAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('nightlyFactExtract advances its cursor when it does run', () => {
    let state = watched(createInitialState('d1'), '2026-08-13T08:00:00.000Z', '2026-08-13T18:00:00.000Z');
    state = { ...state, memory: { ...state.memory, lastFactExtractAt: '2026-08-13T00:00:00.000Z' } };

    const { state: next, effects } = nightlyFactExtract(state, boundary('2026-08-14T00:05:00.000Z', '2026-08-13'));

    expect(effects.find((e: any) => e.type === 'RunFactExtraction')).toBeDefined();
    expect(next.memory.lastFactExtractAt).toBe('2026-08-14T00:05:00.000Z');
  });
});
