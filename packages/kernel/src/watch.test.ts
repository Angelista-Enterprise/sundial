import { describe, it, expect } from 'vitest';
import { backtestWatch, emptyWatchRuntime, stepWatch, validateWatchRule, type WatchRule } from './watch.js';

const at = (min: number) => new Date(Date.parse('2026-09-28T09:00:00.000Z') + min * 60_000).toISOString();
const win = (min: number, processName: string, windowTitle = '') => ({ type: 'window:changed', ts: at(min), payload: { processName, windowTitle } });
const tick = (min: number) => ({ type: 'clock:tick', ts: at(min), payload: {} });
const rule = (over: Record<string, unknown>) => {
  const out = validateWatchRule({ title: 'T', when: { type: 'window:changed' }, say: 'x', ...over });
  if ('error' in out) throw new Error(out.error);
  return out.rule;
};
const said = (r: WatchRule, events: { type: string; ts: string; payload: unknown }[]) => backtestWatch(r, events, () => true).fires.map((f) => f.text);

describe('validateWatchRule', () => {
  it('normalises a good spec and names the id after the title', () => {
    expect(validateWatchRule({ title: 'YouTube at work', when: { type: 'window:changed', where: [{ field: 'windowTitle', op: 'contains', value: 'YouTube' }] }, dwell: { atLeastMin: 20 }, say: 'YouTube for {minutes} min' })).toEqual({
      rule: { id: 'youtube-at-work', title: 'YouTube at work', when: { type: 'window:changed', where: [{ field: 'windowTitle', op: 'contains', value: 'YouTube' }] }, dwell: { atLeastMin: 20 }, say: 'YouTube for {minutes} min', cooldownMin: 60 },
    });
  });
  it('refuses what it cannot run safely', () => {
    const bad = [
      {},
      { title: 't', when: { type: 'clock:tick' }, say: 'x' },
      { title: 't', when: { type: 'nope' }, say: 'x' },
      { title: 't', when: { type: 'window:changed', where: [{ field: 'a', op: 'matches', value: '(' }] }, say: 'x' },
      { title: 't', when: { type: 'window:changed' }, count: { atLeast: 3, withinMin: 5 }, dwell: { atLeastMin: 5 }, say: 'x' },
      { title: 't', when: { type: 'window:changed' } },
    ];
    for (const b of bad) expect('error' in validateWatchRule(b)).toBe(true);
  });
});

describe('stepWatch', () => {
  it('dwell: fires once when a state has held long enough, and again only after it breaks', () => {
    const r = rule({ when: { type: 'window:changed', where: [{ field: 'windowTitle', op: 'contains', value: 'youtube' }] }, dwell: { atLeastMin: 20 }, say: 'YouTube for {minutes} min', cooldownMin: 1 });
    expect(said(r, [win(0, 'Arc', 'YouTube'), tick(10), tick(21), tick(30), win(31, 'Code'), win(40, 'Arc', 'YouTube'), tick(61)])).toEqual(['YouTube for 21 min', 'YouTube for 21 min']);
  });
  it('count: N matches inside the window', () => {
    const r = rule({ when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'slack' }] }, count: { atLeast: 3, withinMin: 10 }, say: '{count} Slack checks' });
    expect(said(r, [win(0, 'Slack'), win(4, 'Slack'), win(20, 'Slack'), win(22, 'Slack'), win(25, 'Slack')])).toEqual(['3 Slack checks']);
  });
  it('absent: daytime silence after a match, once per silence', () => {
    const r = rule({ when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Code' }] }, absent: { forMin: 60 }, say: 'no editor for {minutes} min', cooldownMin: 1 });
    expect(said(r, [win(0, 'Code'), tick(30), tick(61), tick(90), win(100, 'Code'), tick(170)])).toEqual(['no editor for 61 min', 'no editor for 70 min']);
  });
  it('no trigger: every match, with fields filled in and the cooldown kept', () => {
    const r = rule({ when: { type: 'git:commit' }, say: 'committed: {commitLine}', cooldownMin: 30 });
    const ev = (min: number) => ({ type: 'git:commit', ts: at(min), payload: { commitLine: `c${min}` } });
    expect(backtestWatch(r, [ev(0), ev(10), ev(40)], () => true).fires.map((f) => f.text)).toEqual(['committed: c0', 'committed: c40']);
  });
  it('an unrelated event leaves the runtime untouched', () => {
    const r = rule({ dwell: { atLeastMin: 5 } });
    const rt = emptyWatchRuntime();
    expect(stepWatch(r, rt, { type: 'shell:command', ts: at(0), payload: {} }, true).rt).toBe(rt);
  });
});
