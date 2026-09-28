import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { nightlyRefutation, REFUTATION_MIN_INTERVAL_MS, REFUTATION_SAMPLE_SIZE } from './nightly-refutation.js';

const tick = (ts: string): SanitizedEvent => ({ id: 't1', type: 'clock:tick', ts, payload: {}, sanitized: true });

/**
 * The conditions the pass runs under: enabled, night, owner idle, and not run
 * recently. `refutationEnabled` has to be set explicitly because
 * `createInitialState` defaults it to false — which is the safety property, and
 * is asserted on its own below.
 */
function ready(
  overrides: Partial<{ circadian: KernelState['mind']['circadian']; isIdle: boolean; lastRefutationAt: string | null; enabled: boolean }> = {},
): KernelState {
  const base = createInitialState('d1');
  return {
    ...base,
    config: { ...base.config, refutationEnabled: overrides.enabled ?? true },
    mind: { ...base.mind, circadian: overrides.circadian ?? 'night' },
    lifeEvent: { ...base.lifeEvent, idle: { consecutiveZeroWindows: 3, isIdle: overrides.isIdle ?? true } },
    memory: { ...base.memory, lastRefutationAt: overrides.lastRefutationAt ?? null },
  };
}

describe('nightlyRefutation', () => {
  /**
   * The default, and the reason it is the default. This is the only pass whose
   * output SHRINKS core memory, and its dangerous failure is a FALSE refutation
   * — removing something true while the system appears to be self-correcting.
   * `measure-skeptic.ts` establishes that rate; until someone has run it,
   * nothing should be running.
   */
  it('is off on a fresh install, with every other condition met', () => {
    const off = ready({ enabled: false });
    const { state, effects } = nightlyRefutation(off, tick('2026-08-02T02:00:00.000Z'));

    expect(effects).toEqual([]);
    // And no cursor advance, so enabling it later does not start with a
    // suppressed first night.
    expect(state.memory.lastRefutationAt).toBeNull();
  });

  it('defaults to on in a freshly created state', () => {
    expect(createInitialState('d1').config.refutationEnabled).toBe(true);
  });

  it('asks for a pass when it is night and the owner is away', () => {
    const { state, effects } = nightlyRefutation(ready(), tick('2026-08-02T02:00:00.000Z'));

    expect(effects).toMatchObject([{ type: 'RunRefutation', sampleSize: REFUTATION_SAMPLE_SIZE }]);
    expect(state.memory.lastRefutationAt).toBe('2026-08-02T02:00:00.000Z');
  });

  it('ignores anything that is not a tick', () => {
    const { effects } = nightlyRefutation(ready(), { id: 'e', type: 'day:boundary', ts: '2026-08-02T02:00:00.000Z', payload: {}, sanitized: true });
    expect(effects).toEqual([]);
  });

  /**
   * D2/D11 — heavy autonomous work happens while the owner is away, never in
   * the middle of their afternoon. Same gate `endogenousReflection` applies.
   */
  it('will not run during the day, however idle the owner is', () => {
    for (const circadian of ['day', 'evening'] as const) {
      const { state, effects } = nightlyRefutation(ready({ circadian }), tick('2026-08-02T14:00:00.000Z'));
      expect(effects, circadian).toEqual([]);
      // And it must not advance the cursor, or a daytime tick would suppress
      // tonight's real pass.
      expect(state.memory.lastRefutationAt, circadian).toBeNull();
    }
  });

  it('will not run while the owner is still at the desk', () => {
    const { effects } = nightlyRefutation(ready({ isIdle: false }), tick('2026-08-02T02:00:00.000Z'));
    expect(effects).toEqual([]);
  });

  it('runs at most once a day, even across a restart or an odd run of ticks', () => {
    const first = nightlyRefutation(ready(), tick('2026-08-02T02:00:00.000Z'));
    expect(first.effects).toHaveLength(1);

    // Ten minutes later, still night, still idle.
    const second = nightlyRefutation(first.state, tick('2026-08-02T02:10:00.000Z'));
    expect(second.effects).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  it('runs again once the interval has elapsed', () => {
    const last = '2026-08-01T02:00:00.000Z';
    const after = new Date(Date.parse(last) + REFUTATION_MIN_INTERVAL_MS + 1000).toISOString();

    const { effects } = nightlyRefutation(ready({ lastRefutationAt: last }), tick(after));
    expect(effects).toHaveLength(1);
  });

  /**
   * The two nightly passes do opposite jobs — extraction grows core memory,
   * this tries to shrink it — so they must not share a cursor. A night of
   * extraction suppressing a night of refutation would silently disable the
   * only correcting path.
   */
  it('has its own cursor, independent of the extraction pass', () => {
    const base = ready();
    const state: KernelState = { ...base, memory: { ...base.memory, lastFactExtractAt: '2026-08-02T01:59:00.000Z' } };

    const { effects, state: next } = nightlyRefutation(state, tick('2026-08-02T02:00:00.000Z'));

    expect(effects).toHaveLength(1);
    expect(next.memory.lastFactExtractAt).toBe('2026-08-02T01:59:00.000Z');
  });

  /** Small on purpose — this is the only path whose output SHRINKS core memory. */
  it('keeps the sample small', () => {
    expect(REFUTATION_SAMPLE_SIZE).toBeLessThanOrEqual(5);
  });
});
