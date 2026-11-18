import { describe, it, expect } from 'vitest';
import { summarizeBacktest, summarizeFlow, sweepBacktest } from './watch-backtest.js';
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

describe('summarizeFlow — a flow replayed once, each emit fed back in (observatory §2)', () => {
  const failed = rule({ title: 'Commit failed', when: { type: 'shell:command', where: [{ field: 'exitCode', op: 'ne', value: 0 }] }, emit: 'custom:failed', cooldownMin: 1 });
  const published = rule({ title: 'Then published', when: { type: 'custom:failed' }, then: { type: 'git:push', withinMin: 60, absent: false }, by: [], say: 'Fixed and pushed after {from.command}', cooldownMin: 1 });
  const cmd = (id: string, d: number, exitCode: number) => ({ id, type: 'shell:command', ts: day(d), payload: { command: 'pnpm test', exitCode } });
  const push = (id: string, d: number, h = 10.5) => ({ id, type: 'git:push', ts: day(d, h), payload: { remote: 'origin' } });
  const events = [cmd('c1', 9, 1), push('p1', 9), cmd('c2', 5, 1), cmd('c3', 4, 0), push('p2', 4), cmd('c4', 2, 2), push('p3', 2, 14)];

  it('the second step hears the first one\'s emit at the moment it fires, and the chain is its end', () => {
    const out = summarizeFlow([failed, published], events, opts);
    expect(out.steps.map((s) => [s.id, s.fired])).toEqual([['commit-failed', 3], ['then-published', 1]]);
    // The silent step is heard by nobody; the second speaks.
    expect(out.steps[0]).toMatchObject({ heard: 0, gate: { phasic: 0, tonic: 0, suppressed: 0 } });
    expect(out.steps[1]!.examples![0]).toMatchObject({ said: 'Fixed and pushed after pnpm test', evidence: ['p1'] });
    expect(out.chain).toEqual({ fired: 1, heard: out.steps[1]!.heard });
    // Each on its own: the second step never fires, because the log holds no custom:failed.
    expect(summarizeBacktest(published, events, opts).fired).toBe(0);
  });

  it('a branch on the owner\'s answer to an earlier step\'s ask cannot be replayed, nor what hears it', () => {
    const asks = rule({ title: 'Asks', when: { type: 'shell:command' }, do: [{ ask: { question: 'Publish?', choices: ['Yes', 'No'] } }], emit: 'custom:asked', say: 'asked' });
    const yes = rule({ title: 'Yes', when: { type: 'ask:owner-answered', where: [{ field: 'rule', op: 'eq', value: 'asks' }, { field: 'answer', op: 'eq', value: 'Yes' }] }, emit: 'custom:yes', say: 'ok' });
    const after = rule({ title: 'After', when: { type: 'custom:yes' }, say: 'then' });
    const other = rule({ title: 'Other', when: { type: 'custom:asked' }, say: 'also' });
    const out = summarizeFlow([asks, yes, after, other], events, opts);
    expect(out.steps.map((s) => s.untestable ?? s.fired)).toEqual([4, 'waits on your answer', 'waits on your answer', 4]);
    expect(out.chain).toEqual({ fired: 4, heard: out.steps[3]!.heard, untestable: 'waits on your answer' });
  });
});

describe('sweepBacktest — Tune (observatory §2, §6)', () => {
  const spec = { title: 'Pushed soon', when: { type: 'shell:command', where: [{ field: 'exitCode', op: 'ne', value: 0 }] }, then: { type: 'git:push', withinMin: 10, absent: false }, by: [], say: 'pushed', cooldownMin: 1 };
  const events = Array.from({ length: 14 }, (_, d) => [
    { id: `c${d}`, type: 'shell:command', ts: day(14 - d), payload: { exitCode: 1 } },
    { id: `p${d}`, type: 'git:push', ts: new Date(Date.parse(day(14 - d)) + (d % 2 === 0 ? 20 : 50) * 60_000).toISOString(), payload: {} },
  ]).flat();
  it('replays one rule at each value and picks the one closest to once a day, never above three', () => {
    const out = sweepBacktest(spec, { field: 'then.withinMin', from: 10, to: 60, step: 25 }, events, opts);
    expect(out).toEqual({ sweep: [{ value: 10, fired: 0, heard: 0 }, { value: 35, fired: 7, heard: expect.any(Number) }, { value: 60, fired: 14, heard: expect.any(Number) }], best: 60 });
    const many = Array.from({ length: 14 * 5 }, (_, i) => [{ type: 'shell:command', ts: new Date(Date.parse(day(14)) + i * 4 * 3_600_000).toISOString(), payload: { exitCode: 1 } }, { type: 'git:push', ts: new Date(Date.parse(day(14)) + i * 4 * 3_600_000 + 60_000).toISOString(), payload: {} }]).flat();
    expect(sweepBacktest(spec, { field: 'then.withinMin', from: 5, to: 5, step: 1 }, many, opts)).toEqual({ sweep: [{ value: 5, fired: 70, heard: expect.any(Number) }], best: null });
    expect(sweepBacktest(spec, { field: 'count.atLeast', from: 1, to: 3, step: 1 }, events, opts)).toEqual({ error: 'the rule has no count to sweep' });
    expect('error' in sweepBacktest(spec, { field: 'then.withinMin', from: 1, to: 1000, step: 1 }, events, opts)).toBe(true);
  });
});
