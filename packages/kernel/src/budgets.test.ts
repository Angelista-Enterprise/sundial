import { describe, it, expect } from 'vitest';
import { DEFAULT_DAILY_CAPS, resolveDailyCaps } from './budgets.js';

describe('resolveDailyCaps', () => {
  it('returns the defaults unchanged when called with no overrides', () => {
    expect(resolveDailyCaps()).toEqual(DEFAULT_DAILY_CAPS);
  });

  it('returns the defaults unchanged for an empty overrides object', () => {
    expect(resolveDailyCaps({})).toEqual(DEFAULT_DAILY_CAPS);
  });

  // Every purpose here must have something that can REQUEST it: three rules
  // (`momentAnalysisSchedule` → intent, `noticeGate` → companion,
  // `researchGoals` → goal), the runtime's nightly passes (journal, extract,
  // reflect, refute) and the owner's own chat (ask). `narrate` was merged into
  // `intent` and `knowledge` lost its producer in the dsh rebuild; both kept a
  // cap for months, which is why this list is written out rather than derived.
  // The seven judgement purposes are requested by a `Judge` effect
  // (`dispatchJudge`, docs/jarvis/02) — Jev's slots, apart from the text model's.
  it('caps exactly the purposes something can actually request', () => {
    expect(Object.keys(DEFAULT_DAILY_CAPS).sort()).toEqual(
      ['ask', 'companion', 'extract', 'goal', 'intent', 'journal', 'reflect', 'refute', 'transcript', 'perceive', 'classify', 'rank', 'judge', 'audit', 'forecast', 'listen'].sort(),
    );
  });

  it('overrides a recognized purpose with a positive number', () => {
    const resolved = resolveDailyCaps({ intent: 500 });
    expect(resolved.intent).toBe(500);
    expect(resolved.companion).toBe(DEFAULT_DAILY_CAPS.companion);
  });

  it('ignores an unrecognized purpose key rather than injecting it', () => {
    const resolved = resolveDailyCaps({ madeUpPurpose: 999 });
    expect(resolved).toEqual(DEFAULT_DAILY_CAPS);
    expect((resolved as Record<string, number>).madeUpPurpose).toBeUndefined();
  });

  it('ignores a zero or negative override, keeping the default', () => {
    const resolved = resolveDailyCaps({ intent: 0, companion: -5 });
    expect(resolved.intent).toBe(DEFAULT_DAILY_CAPS.intent);
    expect(resolved.companion).toBe(DEFAULT_DAILY_CAPS.companion);
  });

  it('does not mutate DEFAULT_DAILY_CAPS itself', () => {
    resolveDailyCaps({ intent: 999 });
    expect(DEFAULT_DAILY_CAPS.intent).toBe(2000);
  });
});
