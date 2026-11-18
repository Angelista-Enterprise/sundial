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

describe('Round 4: anticipatory rows past a spent budget (FORESIGHT 4d)', () => {
  const prep = { shape: 'anticipatory', kind: 'meeting-prep', key: 'prep:1', surprise: 1, precision: 1, valueHalfLifeMs: null, observation: 'Planning with Mira Bakker at 14:00.', evidence: [], concerns: [] } as const;
  const ambient = { ...prep, shape: 'transition', kind: 'return-from-break', key: 'back:1' } as const;
  const today = '2026-09-01';
  const spent = (n: number) => ({ habituation: {}, day: today, spentToday: n });

  it('a meeting prep after the budget is spent reaches the list; an ordinary row does not', () => {
    expect(decide(DEFAULT_GATE_POLICY, spent(4), prep as never, at(3), today)).toMatchObject({ channel: 'tonic', reason: 'anticipatory' });
    expect(decide(DEFAULT_GATE_POLICY, spent(4), ambient as never, at(3), today)).toMatchObject({ channel: 'suppressed', reason: 'budget-spent' });
    // Inside the budget it is an ordinary admission.
    expect(decide(DEFAULT_GATE_POLICY, spent(1), prep as never, at(3), today).reason).toBe('admitted');
  });

  it('bounded: two rows over the budget, then budget-spent like anything else', () => {
    expect(decide(DEFAULT_GATE_POLICY, spent(5), prep as never, at(3), today).reason).toBe('anticipatory');
    expect(decide(DEFAULT_GATE_POLICY, spent(6), prep as never, at(3), today).reason).toBe('budget-spent');
    expect(decide({ ...DEFAULT_GATE_POLICY, anticipatoryOverBudget: 0 }, spent(4), prep as never, at(3), today).reason).toBe('budget-spent');
    // A day of twelve meetings after four ordinary rows: two preps more, never twelve.
    const items = [...Array.from({ length: 4 }, (_, i) => ({ candidate: { ...ambient, key: `back:${i}` }, ts: at(i * 0.1) })), ...Array.from({ length: 12 }, (_, i) => ({ candidate: { ...prep, key: `prep:${i}` }, ts: at(1 + i * 0.5) }))];
    expect(simulateGate(DEFAULT_GATE_POLICY, items as never, 'UTC')).toMatchObject({ tonic: 6, suppressed: 10, reasons: { 'budget-spent': 10 } });
  });

  it('habituation is unaffected: a prep already said wears down, and the budget rule does not let it past', () => {
    const worn = { habituation: { 'prep:1': { gain: 0.064, at: at(2.9), fires: 3 } }, day: today, spentToday: 4 };
    expect(decide(DEFAULT_GATE_POLICY, worn, prep as never, at(3), today)).toMatchObject({ channel: 'suppressed', reason: 'habituated' });
  });
});
