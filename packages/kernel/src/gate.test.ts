import { describe, it, expect } from 'vitest';
import { decide, DEFAULT_GATE_POLICY, policyForBias, simulateGate } from './gate.js';
import { backtestWatch, validateWatchRule } from './watch.js';

const at = (h: number) => new Date(Date.parse('2026-09-01T09:00:00.000Z') + h * 3_600_000).toISOString();
const checked = validateWatchRule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', cooldownMin: 1 });
if (!('rule' in checked)) throw new Error('bad spec');
// One stream for the whole rule (`by: []`), so nine rows on one PR are nine fires for the gate to weigh.
const one = validateWatchRule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, by: [], say: 'CI failed on #{number}', cooldownMin: 1 });
if (!('rule' in one)) throw new Error('bad spec');
const global = one.rule;
const fail = (h: number, number: number) => ({ type: 'git:pr-status', ts: at(h), payload: { number, checkState: 'failure' } });

describe('simulateGate — the backtest hears what the gate would say (UC4 F2)', () => {
  it('nine fires on one PR are not nine interruptions: habituation holds the repeats back', () => {
    const { fires } = backtestWatch(global, Array.from({ length: 9 }, (_, i) => fail(i, 812)), { daytime: () => true });
    const sim = simulateGate(policyForBias(0), fires.map((f) => ({ candidate: f.candidate, ts: f.at })), 'UTC');
    expect(fires).toHaveLength(9);
    expect(sim.phasic + sim.tonic + sim.suppressed).toBe(9);
    expect(sim.phasic).toBe(1);
    expect(sim.reasons.habituated).toBe(8);
    expect(sim.channels[0]).toBe('phasic');
  });

  it('nine different PRs a day apart are all heard at dial 0, and none at dial +1', () => {
    const { fires } = backtestWatch(checked.rule, Array.from({ length: 9 }, (_, i) => fail(i * 24, 800 + i)), { daytime: () => true });
    const items = fires.map((f) => ({ candidate: f.candidate, ts: f.at }));
    expect(simulateGate(policyForBias(0), items, 'UTC')).toMatchObject({ phasic: 9, suppressed: 0 });
    expect(simulateGate(policyForBias(1), items, 'UTC')).toMatchObject({ phasic: 0, tonic: 0, suppressed: 9, reasons: { 'below-threshold': 9 } });
  });

  it('counts the day\'s interruptions: the seventh different PR in one day goes to the list', () => {
    const { fires } = backtestWatch(checked.rule, Array.from({ length: 7 }, (_, i) => fail(i * 0.1, 900 + i)), { daytime: () => true });
    expect(simulateGate(policyForBias(0), fires.map((f) => ({ candidate: f.candidate, ts: f.at })), 'UTC')).toMatchObject({ phasic: 6, tonic: 1 });
  });
});

describe('the owner-question reserve', () => {
  const ask = { shape: 'self-report', kind: 'owner-question', key: 'owner-ask:a1', surprise: 2, precision: 1, valueHalfLifeMs: 2 * 3_600_000, observation: 'Did the draft reach Mira?', evidence: [], concerns: [] } as const;
  const other = { ...ask, shape: 'transition', kind: 'day-runs-long', key: 'day-runs-long:1' } as const;
  const day = (phasicToday: number) => ({ habituation: {}, day: '2026-09-01', spentToday: 0, phasicToday });
  const cap = DEFAULT_GATE_POLICY.phasicDailyCap;

  it('an owner question still interrupts once the day\'s cap is spent, and only once over it', () => {
    expect(decide(DEFAULT_GATE_POLICY, day(cap), other as never, at(1), '2026-09-01').channel).toBe('tonic');
    expect(decide(DEFAULT_GATE_POLICY, day(cap), ask as never, at(1), '2026-09-01').channel).toBe('phasic');
    expect(decide(DEFAULT_GATE_POLICY, day(cap + 1), ask as never, at(1), '2026-09-01').channel).toBe('tonic');
  });
});
