import { describe, expect, it } from 'vitest';
import { DEFAULT_GATE_POLICY } from './gate.js';
import type { NoticeCandidate } from './types.js';
import { candidateOf, whatIf, type ReplayItem } from './what-if.js';

const TZ = 'UTC';
const urgent = (kind: string, key: string): NoticeCandidate => ({
  shape: 'transition',
  kind,
  key,
  surprise: 3,
  precision: 1,
  valueHalfLifeMs: 30 * 60_000,
  observation: `${kind} on ${key}`,
  evidence: [],
  concerns: [],
});

/** Five distinct interruptions on one day, each strong enough to be said. */
const day: ReplayItem[] = Array.from({ length: 5 }, (_, i) => ({
  id: `n${i}`,
  ts: `2026-09-28T${10 + i}:00:00.000Z`,
  candidate: urgent(i % 2 === 0 ? 'agent-waiting' : 'owner-question', `k${i}`),
  recorded: 'phasic' as const,
}));

describe('whatIf', () => {
  const run = (variant = DEFAULT_GATE_POLICY, change = {}, added?: ReplayItem[]) =>
    whatIf(day, { base: DEFAULT_GATE_POLICY, variant, change, from: '2026-09-28T00:00:00.000Z', days: 1, zone: TZ, ...(added ? { added } : {}) });

  it('no change is no delta, and the replay agrees with the record', () => {
    const r = run();
    expect(r.delta).toEqual({ phasic: 0, tonic: 0 });
    expect(r.agreement).toBe('the replay matches the recorded channel on 5 of 5 candidates with a decision on record');
  });

  it('a cap of 3 names the pings that would have been missed, with n', () => {
    const r = run({ ...DEFAULT_GATE_POLICY, phasicDailyCap: 3 }, { cap: 3 });
    expect(r.now.phasic).toBe(5);
    // The two after the third; an owner question keeps one slot over the cap.
    expect(r.missedTotal).toBe(1);
    expect(r.missed[0]).toMatchObject({ kind: 'agent-waiting', was: 'phasic', now: 'tonic' });
    expect(r.delta.phasic).toBe(-1);
  });

  it('muting a kind takes it out of the stream', () => {
    const r = run(DEFAULT_GATE_POLICY, { mute: ['agent-*'] });
    expect(r.missedTotal).toBe(3);
    expect(r.missed.every((l) => l.now === 'muted')).toBe(true);
    expect(r.byKind['agent-waiting']).toEqual({ now: 3, changed: 0, n: 3 });
  });

  it('a rule turned on competes for the same cap', () => {
    const fires: ReplayItem[] = [{ id: 'rule:0', ts: '2026-09-28T09:30:00.000Z', candidate: urgent('watch:ci', 'watch:ci:1') }];
    const r = run({ ...DEFAULT_GATE_POLICY, phasicDailyCap: 5 }, { cap: 5 }, fires);
    expect(r.added).toEqual({ fires: 1, phasic: 1, tonic: 0 });
    expect(r.gainedTotal).toBe(1);
    // Five slots and six things to say: the last agent ping loses its interruption.
    expect(r.missed.map((l) => l.kind)).toEqual(['agent-waiting']);
  });

  it('a recorded cost can defer in the replay, as it did live', () => {
    // Weight 2 clears the bar to interrupt (1.6), and less the full cost (0.8) it no longer does.
    const costly = whatIf([{ ...day[0]!, candidate: { ...day[0]!.candidate, surprise: 2 }, cost: 1, recorded: 'deferred' }], { base: DEFAULT_GATE_POLICY, variant: DEFAULT_GATE_POLICY, change: {}, from: '2026-09-28T00:00:00.000Z', days: 1, zone: TZ });
    expect(costly.now.deferred).toBe(1);
    expect(costly.agreement).toContain('1 of 1');
  });
});

describe('candidateOf', () => {
  it('reads a recorded candidate payload, and refuses a row that is not one', () => {
    expect(candidateOf({ kind: 'agent-waiting', key: 'k', surprise: 2, precision: 0.9, valueHalfLifeMs: 60_000, observation: 'x', timestamp: 'now' })).toMatchObject({ kind: 'agent-waiting', valueHalfLifeMs: 60_000, evidence: [], concerns: [] });
    expect(candidateOf({ kind: 'x' })).toBeNull();
  });
});
