import { describe, it, expect } from 'vitest';
import { summarizeBacktest } from './watch-backtest.js';
import { validateWatchRule } from './watch.js';

const now = '2026-10-15T00:00:00.000Z';
const day = (d: number, h = 10) => new Date(Date.parse(now) - d * 86_400_000 + h * 3_600_000).toISOString();
const rule = (spec: Record<string, unknown>) => {
  const out = validateWatchRule(spec);
  if ('error' in out) throw new Error(out.error);
  return out.rule;
};
const opts = { days: 14, zone: 'UTC', dial: 0, silent: false, now, daytime: () => true };

describe('summarizeBacktest — what gnomon_test_rule reports (U4-F23 F26 F27)', () => {
  const ci = rule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}' });
  const pr = (id: string, d: number, number: number, checkState: string) => ({ id, type: 'git:pr-status', ts: day(d), payload: { number, checkState } });
  const events = [pr('s1', 12, 1, 'failure'), pr('s2', 11, 1, 'success'), pr('s3', 10, 1, 'failure'), pr('s4', 3, 2, 'failure'), pr('s5', 2, 3, 'failure'), pr('s6', 1, 3, 'failure')];
  const out = summarizeBacktest(ci, events, opts);

  it('splits the days into an older and a recent half, each with its n', () => {
    expect(out.fired).toBe(4);
    expect(out.holdout).toEqual({ older: { days: 7, fired: 2 }, recent: { days: 7, fired: 2 } });
  });
  it('counts fires per thing, hashed, and they add up to fired', () => {
    expect(Object.keys(out.byKey)).toHaveLength(3);
    expect(Object.keys(out.byKey).every((k) => /^[0-9a-f]{6}$/.test(k))).toBe(true);
    expect(Object.values(out.byKey).reduce((a, b) => a + b, 0)).toBe(out.fired);
  });
  it('names the signal ids behind each example, and they are rows of the log', () => {
    const ids = new Set(events.map((e) => e.id));
    expect(out.examples.map((e) => e.evidence)).toEqual([['s1'], ['s3'], ['s4'], ['s5']]);
    expect(out.examples.every((e) => e.evidence.length > 0 && e.evidence.every((id) => ids.has(id)))).toBe(true);
    expect(out.examples.map((e) => e.heard)).toEqual(['phasic', 'suppressed', 'phasic', 'phasic']); // PR 1 again two days later is habituated
  });
  it('a rule that never fired says how close it came', () => {
    const three = rule({ title: 'Three reds', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, count: { atLeast: 5, withinMin: 10080 }, say: '{count} reds' });
    expect(summarizeBacktest(three, events, opts)).toMatchObject({ fired: 0, nearest: 'closest: 3 matches in its window' });
  });
});
