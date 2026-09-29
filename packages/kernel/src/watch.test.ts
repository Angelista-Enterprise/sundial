import { describe, it, expect } from 'vitest';
import { hydrateSnapshot } from './initial-state.js';
import { activeAt, backtestWatch, describeRule, fromBlueprint, inWindow, isRuleIntent, matchesWatch, resolvePeople, toBlueprint, emptyWatchFlags, emptyWatchRuntime, stepWatch, stepWatchFlags, validateWatchRule, type WatchRule } from './watch.js';

const at = (min: number) => new Date(Date.parse('2026-09-28T09:00:00.000Z') + min * 60_000).toISOString();
const win = (min: number, processName: string, windowTitle = '') => ({ type: 'window:changed', ts: at(min), payload: { processName, windowTitle } });
const tick = (min: number) => ({ type: 'clock:tick', ts: at(min), payload: {} });
const rule = (over: Record<string, unknown>) => {
  const out = validateWatchRule({ title: 'T', when: { type: 'window:changed' }, say: 'x', ...over });
  if ('error' in out) throw new Error(out.error);
  return out.rule;
};
const said = (r: WatchRule, events: { type: string; ts: string; payload: unknown }[]) => backtestWatch(r, events, { daytime: () => true }).fires.map((f) => f.text);

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
      { title: 't', when: { type: 'window:changed', where: [{ field: 'a', op: 'matches', value: '(a+)+$' }] }, say: 'x' },
      { title: 't', when: { type: 'window:changed', where: [{ field: 'a', op: 'matches', value: '(.*x)*' }] }, say: 'x' },
      { title: 't', when: { type: 'window:changed', where: [{ field: 'a', op: 'matches', value: 'a'.repeat(201) }] }, say: 'x' },
      { title: 't', when: { type: 'window:changed' }, count: { atLeast: 3, withinMin: 5 }, dwell: { atLeastMin: 5 }, say: 'x' },
      { title: 't', when: { type: 'window:changed' } },
    ];
    for (const b of bad) expect('error' in validateWatchRule(b)).toBe(true);
    // An ordinary group or alternation is still fine.
    expect('rule' in validateWatchRule({ title: 't', when: { type: 'window:changed', where: [{ field: 'a', op: 'matches', value: '(slack|teams)+ call' }] }, say: 'x' })).toBe(true);
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
    const r = rule({ when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Code' }] }, absent: { forMin: 60, clock: 'wall' }, say: 'no editor for {minutes} min', cooldownMin: 1 });
    expect(said(r, [win(0, 'Code'), tick(30), tick(61), tick(90), win(100, 'Code'), tick(170)])).toEqual(['no editor for 61 min', 'no editor for 70 min']);
  });
  it('no trigger: every match, with fields filled in and the cooldown kept', () => {
    const r = rule({ when: { type: 'git:commit' }, say: 'committed: {commitLine}', cooldownMin: 30 });
    const ev = (min: number) => ({ type: 'git:commit', ts: at(min), payload: { commitLine: `c${min}` } });
    expect(backtestWatch(r, [ev(0), ev(10), ev(40)], { daytime: () => true }).fires.map((f) => f.text)).toEqual(['committed: c0', 'committed: c40']);
  });
  it('an unrelated event leaves the runtime untouched', () => {
    const r = rule({ dwell: { atLeastMin: 5 } });
    const rt = emptyWatchRuntime();
    expect(stepWatch(r, rt, { type: 'shell:command', ts: at(0), payload: {} }, { daytime: true }).rt).toBe(rt);
  });
});

describe('by — one runtime per thing (U4-F3)', () => {
  const status = (min: number, cwd: string, dirtyFiles: number) => ({ type: 'git:status', ts: at(min), payload: { cwd, branch: 'main', dirtyFiles } });
  // The shape of the rule adopted live: a dwell on git:status with no `by`.
  const pile = rule({ title: 'Uncommitted pile', when: { type: 'git:status', where: [{ field: 'dirtyFiles', op: 'gt', value: 16 }] }, dwell: { atLeastMin: 75 }, say: '{cwd} has {dirtyFiles} uncommitted files for {minutes} minutes', cooldownMin: 360 });

  it('a state stream is grouped by the thing it is about; a count keeps one stream; by: [] opts out', () => {
    expect(pile.by).toEqual(['cwd']);
    expect(rule({ when: { type: 'git:pr-status' } }).by).toEqual(['number']);
    expect(rule({ when: { type: 'git:status' }, count: { atLeast: 2, withinMin: 10 } }).by).toBeUndefined();
    expect(rule({ when: { type: 'git:status' }, dwell: { atLeastMin: 5 }, by: [] }).by).toEqual([]);
    expect(rule({ when: { type: 'window:changed' }, dwell: { atLeastMin: 5 } }).by).toBeUndefined();
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:status' }, by: ['a', 'b', 'c', 'd'], say: 'x' })).toBe(true);
  });

  it('another repo\'s clean status no longer ends a dirty stretch: the adopted rule fires for the dirty repo only', () => {
    const events: { type: string; ts: string; payload: unknown }[] = [status(0, '/r/puzzlebox', 20)];
    for (let m = 5; m <= 90; m += 5) events.push(status(m, '/r/other', 0), tick(m));
    expect(said(pile, events)).toEqual(['/r/puzzlebox has 20 uncommitted files for 75 minutes']);
    // Without grouping (by: []) the same log never fires: the stretch the live rule never saw.
    expect(said({ ...pile, by: [] }, events)).toEqual([]);
  });

  it('a snapshot\'s rule adopted before the natural key gets it on hydrate, and groups per cwd', () => {
    const { by: _none, ...old } = pile;
    const hydrated = hydrateSnapshot('d', { watch: { rules: [old], runtime: {} } } as never).watch!.rules[0]!;
    expect(hydrated.by).toEqual(['cwd']);
    const events: { type: string; ts: string; payload: unknown }[] = [status(0, '/r/puzzlebox', 20)];
    for (let m = 5; m <= 90; m += 5) events.push(status(m, '/r/other', 0), tick(m));
    expect(said(hydrated, events)).toEqual(['/r/puzzlebox has 20 uncommitted files for 75 minutes']);
    // A count, or an explicit by: [], is left as adopted.
    const counted = rule({ when: { type: 'git:status' }, count: { atLeast: 2, withinMin: 10 } });
    const single = { ...pile, by: [] };
    expect(hydrateSnapshot('d', { watch: { rules: [counted, single], runtime: {} } } as never).watch!.rules.map((r) => r.by)).toEqual([undefined, []]);
  });

  it('an untriggered rule fires when a thing starts matching: a re-reported failure is the same failure', () => {
    const ci = rule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', cooldownMin: 1 });
    const pr = (min: number, number: number, checkState: string) => ({ type: 'git:pr-status', ts: at(min), payload: { number, checkState } });
    expect(said(ci, [pr(0, 812, 'failure'), pr(10, 812, 'failure'), pr(20, 813, 'failure'), pr(30, 812, 'success'), pr(40, 812, 'failure')])).toEqual(['CI failed on #812', 'CI failed on #813', 'CI failed on #812']);
  });

  it('the cooldown is per thing, and the keys are bounded', () => {
    const r = rule({ title: 'Dirty', when: { type: 'git:status', where: [{ field: 'dirtyFiles', op: 'gt', value: 0 }] }, say: '{cwd}', cooldownMin: 600 });
    expect(said(r, [status(0, '/a', 1), status(1, '/b', 1), status(2, '/a', 0), status(3, '/a', 1)])).toEqual(['/a', '/b']);
    let rt = emptyWatchRuntime();
    for (let i = 0; i < 60; i++) rt = stepWatch(r, rt, status(i, `/repo${i}`, 1), { daytime: true }).rt;
    expect(Object.keys(rt.keys ?? {})).toHaveLength(50);
    expect(rt.keys?.['/repo59']).toBeDefined();
    expect(rt.keys?.['/repo0']).toBeUndefined();
  });
});

describe('active-time clocks (U4-F5, U4-F6)', () => {
  type Ev = { type: string; ts: string; payload: unknown };
  const ticks = (from: number, to: number): Ev[] => Array.from({ length: to - from + 1 }, (_, i) => tick(from + i));
  const commit = (min: number): Ev => ({ type: 'git:commit', ts: at(min), payload: { commitLine: `c${min}` } });
  const sleep = (min: number, kind: 'sleep' | 'wake'): Ev => ({ type: 'system:sleep-wake', ts: at(min), payload: { kind } });
  const byTime = (events: Ev[]) => events.sort((a, b) => a.ts.localeCompare(b.ts));
  const daytime = (ts: string) => new Date(ts).getUTCHours() >= 6 && new Date(ts).getUTCHours() < 18;

  it('flags count only minutes at the machine: idle and sleep are left out, and so is a gap nothing watched', () => {
    let f = emptyWatchFlags();
    for (const e of byTime([...ticks(0, 60), { type: 'idle:start', ts: at(30), payload: {} }, { type: 'idle:end', ts: at(40), payload: {} }])) f = stepWatchFlags(f, e);
    expect(f.activeMs / 60_000).toBe(50);
    f = stepWatchFlags(f, tick(200)); // 140 minutes with no tick: the machine was off
    expect(f.activeMs / 60_000).toBe(50);
    expect(activeAt(f, at(202)) / 60_000).toBe(52);
    expect(stepWatchFlags(f, { type: 'window:changed', ts: at(203), payload: {} })).toBe(f);
  });

  it('"no commit for 6 hours" counts the working day, not the night: it never fires at the first tick of a morning', () => {
    const r = rule({ title: 'No commits', when: { type: 'git:commit' }, absent: { forMin: 360 }, say: 'no commit for {minutes} min' });
    expect(r.absent).toEqual({ forMin: 360, clock: 'active' });
    // Three days: a commit at 09:00 and 16:00 (UTC here), awake 08:00–23:00, asleep until the next 08:00.
    const days: Ev[] = [];
    for (let d = 0; d < 3; d++) {
      const o = d * 1440 - 60; // at(0) is 09:00, so 08:00 is -60
      days.push(sleep(o, 'wake'), ...ticks(o, o + 900), commit(o + 60), commit(o + 480), sleep(o + 900, 'sleep'));
    }
    const wall = backtestWatch(rule({ title: 'No commits', when: { type: 'git:commit' }, absent: { forMin: 360, clock: 'wall' }, say: 'x' }), byTime([...days]), { daytime }).fires;
    expect(wall.map((f) => f.at.slice(11, 16))).toEqual(['15:00', '08:00', '15:00', '08:00', '15:00']); // the old reading: the night alone is six hours
    const fires = backtestWatch(r, byTime([...days]), { daytime }).fires;
    // 09:00 → 15:00 and 16:00 → 22:00 are six awake hours with no commit. The morning is not.
    expect(fires.map((f) => f.at.slice(11, 16))).toEqual(['15:00', '22:00', '15:00', '22:00', '15:00', '22:00']);
  });

  it('an active dwell leaves a sleep out: a window left frontmost overnight is not hours of use', () => {
    const slack = { title: 'Chat dwell', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chat' }] }, say: 'chat for {minutes} min' };
    const events = byTime([win(0, 'Chat'), ...ticks(0, 10), sleep(10, 'sleep'), sleep(600, 'wake'), ...ticks(600, 612)]);
    expect(said(rule({ ...slack, dwell: { atLeastMin: 20 } }), events)).toEqual(['chat for 600 min']);
    expect(said(rule({ ...slack, dwell: { atLeastMin: 20, clock: 'active' } }), events)).toEqual(['chat for 20 min']);
  });
});

describe('during — the owner\'s hours, in their zone (U4-F7)', () => {
  const zone = 'Europe/Berlin';
  it('"after 22:00 local" holds in summer and winter time, and a window that wraps midnight belongs to the day it starts', () => {
    const late = { from: '22:00', to: '04:00' };
    expect(inWindow(late, '2026-07-01T20:30:00Z', zone)).toBe(true); // 22:30 CEST
    expect(inWindow(late, '2026-12-01T21:30:00Z', zone)).toBe(true); // 22:30 CET
    expect(inWindow(late, '2026-12-01T20:30:00Z', zone)).toBe(false); // 21:30 CET
    expect(inWindow(late, '2026-12-02T02:59:00Z', zone)).toBe(true); // 03:59
    const friday = { days: [5], from: '22:00', to: '04:00' };
    expect(inWindow(friday, '2026-10-02T21:00:00Z', zone)).toBe(true); // Fri 23:00
    expect(inWindow(friday, '2026-10-03T00:00:00Z', zone)).toBe(true); // Sat 02:00, Friday's night
    expect(inWindow(friday, '2026-10-03T21:00:00Z', zone)).toBe(false); // Sat 23:00
    expect(inWindow({ days: [1, 2, 3, 4, 5] }, '2026-10-03T10:00:00Z', zone)).toBe(false);
  });
  it('outside the window a rule neither counts nor speaks', () => {
    const r = rule({ title: 'Late coding', when: { type: 'shell:command' }, count: { atLeast: 3, withinMin: 30 }, during: { from: '22:00', to: '04:00' }, say: '{count} commands late' });
    const cmd = (iso: string) => ({ type: 'shell:command', ts: iso, payload: { command: 'x' } });
    const events = ['2026-10-01T19:50:00Z', '2026-10-01T19:55:00Z', '2026-10-01T20:01:00Z', '2026-10-01T20:05:00Z', '2026-10-01T20:09:00Z'].map(cmd); // 21:50 … 22:09 CEST
    expect(backtestWatch(r, events, { daytime: () => true, timeZone: zone }).fires.map((f) => f.at)).toEqual(['2026-10-01T20:09:00Z']);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'shell:command' }, during: { from: '25:00', to: '04:00' }, say: 'x' })).toBe(true);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'shell:command' }, during: { days: [0] }, say: 'x' })).toBe(true);
  });
});

describe('more ops: ne, in, exists and one level of anyOf (U4-F8)', () => {
  const pr = (payload: Record<string, unknown>) => ({ type: 'git:pr-status', ts: at(0), payload });
  const m = (spec: Record<string, unknown>, payload: Record<string, unknown>) => matchesWatch(rule({ when: { type: 'git:pr-status', ...spec } }), 'git:pr-status', pr(payload).payload);
  it('state in [OPEN, DRAFT] matches both, ne and exists do what they say', () => {
    const open = { where: [{ field: 'state', op: 'in', value: ['OPEN', 'DRAFT'] }] };
    expect(m(open, { state: 'OPEN' })).toBe(true);
    expect(m(open, { state: 'draft' })).toBe(true);
    expect(m(open, { state: 'MERGED' })).toBe(false);
    expect(m({ where: [{ field: 'checkState', op: 'ne', value: 'success' }] }, { checkState: 'failure' })).toBe(true);
    expect(m({ where: [{ field: 'checkState', op: 'ne', value: 'success' }] }, { checkState: 'success' })).toBe(false);
    expect(m({ where: [{ field: 'backfill', op: 'exists', value: false }] }, {})).toBe(true);
    expect(m({ where: [{ field: 'backfill', op: 'exists', value: false }] }, { backfill: true })).toBe(false);
  });
  it('anyOf: at least one group holds, beside the ANDed where', () => {
    const spec = { where: [{ field: 'state', op: 'eq', value: 'OPEN' }], anyOf: [[{ field: 'checkState', op: 'eq', value: 'failure' }], [{ field: 'reviewState', op: 'eq', value: 'changes_requested' }]] };
    expect(m(spec, { state: 'OPEN', checkState: 'failure' })).toBe(true);
    expect(m(spec, { state: 'OPEN', reviewState: 'changes_requested' })).toBe(true);
    expect(m(spec, { state: 'OPEN', checkState: 'success', reviewState: 'approved' })).toBe(false);
    expect(m(spec, { state: 'MERGED', checkState: 'failure' })).toBe(false);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:pr-status', anyOf: [[{ field: 'a', op: 'eq', value: 1 }]] }, say: 'x' })).toBe(true);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:pr-status', where: [{ field: 'a', op: 'in', value: 'x' }] }, say: 'x' })).toBe(true);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:pr-status', where: [{ field: 'a', op: 'exists', value: 'yes' }] }, say: 'x' })).toBe(true);
  });
});

describe('lists: any item, and one thing per item (U4-F11)', () => {
  const fleet = (min: number, sessions: { id: string; state: string }[]) => ({ type: 'agent:fleet', ts: at(min), payload: { sessions } });
  const ticks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => tick(from + i));
  it('two sessions, one waiting ten minutes: it fires for that one, by its id', () => {
    const r = rule({ title: 'Agent waits', when: { type: 'agent:fleet', where: [{ field: 'sessions[].state', op: 'eq', value: 'waiting' }] }, dwell: { atLeastMin: 10 }, say: '{sessions[].id} waits' });
    expect(r.by).toEqual(['sessions[].id']);
    const events = [fleet(0, [{ id: 's1', state: 'waiting' }, { id: 's2', state: 'working' }]), ...ticks(1, 5), fleet(6, [{ id: 's1', state: 'waiting' }, { id: 's2', state: 'waiting' }]), ...ticks(7, 12)];
    expect(said(r, events)).toEqual(['s1 waits']);
  });
  it('a session gone from the snapshot has stopped waiting; the old stringified hack now works per session too', () => {
    const hack = rule({ title: 'Agent waits', when: { type: 'agent:fleet', where: [{ field: 'sessions', op: 'contains', value: '"state":"waiting"' }] }, dwell: { atLeastMin: 10 }, say: '{sessions.id} waits' });
    const events = [fleet(0, [{ id: 's1', state: 'waiting' }]), ...ticks(1, 4), fleet(5, []), fleet(6, [{ id: 's1', state: 'waiting' }]), ...ticks(7, 15), fleet(16, [{ id: 's1', state: 'waiting' }, { id: 's3', state: 'waiting' }]), ...ticks(17, 27)];
    expect(said(hack, events)).toEqual(['s1 waits', 's3 waits']);
    expect(backtestWatch(hack, events, { daytime: () => true }).fires.map((f) => f.at)).toEqual([at(16), at(26)]);
  });
  it('without by, a list condition holds when any item does', () => {
    const any = rule({ title: 'Any waits', when: { type: 'agent:fleet', where: [{ field: 'sessions[].state', op: 'eq', value: 'waiting' }] }, by: [], say: 'one waits' });
    expect(said(any, [fleet(0, [{ id: 'a', state: 'working' }]), fleet(1, [{ id: 'a', state: 'working' }, { id: 'b', state: 'waiting' }])])).toEqual(['one waits']);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'agent:fleet' }, by: ['sessions[].id', 'other[].id'], say: 'x' })).toBe(true);
  });
});

describe('count.distinct, and calendar re-sends (U4-F10)', () => {
  const meeting = (min: number, eventId: string, isAllDay = false) => ({ type: 'calendar:active', ts: at(min), payload: { event: { eventId, isAllDay, title: 'Sync' } } });
  it('a hundred samples of one meeting never reach three; three meetings do', () => {
    const r = rule({ title: 'Back to back', when: { type: 'calendar:active', where: [{ field: 'event.isAllDay', op: 'ne', value: true }] }, count: { atLeast: 3, withinMin: 180 }, say: '{count} meetings in a row' });
    expect(r.count).toEqual({ atLeast: 3, withinMin: 180, distinct: 'event.eventId' });
    expect(said(r, Array.from({ length: 100 }, (_, i) => meeting(i, 'm1')))).toEqual([]);
    expect(said(r, [meeting(0, 'm1'), meeting(5, 'm1'), meeting(60, 'm2'), meeting(61, 'm2'), meeting(120, 'm3')])).toEqual(['3 meetings in a row']);
    // An all-day entry is not a meeting the owner sits in.
    expect(said(r, [meeting(0, 'd1', true), meeting(60, 'd2', true), meeting(120, 'd3', true)])).toEqual([]);
  });
  it('distinct on any field; and an untriggered calendar rule says a re-sent meeting once', () => {
    const r = rule({ title: 'Three repos failing', when: { type: 'shell:command', where: [{ field: 'exitCode', op: 'gt', value: 0 }] }, count: { atLeast: 3, withinMin: 30, distinct: 'cwd' }, say: '{count} repos failing' });
    const cmd = (min: number, cwd: string) => ({ type: 'shell:command', ts: at(min), payload: { cwd, exitCode: 1 } });
    expect(said(r, [cmd(0, '/a'), cmd(1, '/a'), cmd(2, '/b'), cmd(3, '/a'), cmd(4, '/c')])).toEqual(['3 repos failing']);
    const each = rule({ title: 'Meeting started', when: { type: 'calendar:active' }, say: '{event.title} started', cooldownMin: 1 });
    expect(said(each, Array.from({ length: 50 }, (_, i) => meeting(i * 5, 'm1')))).toEqual(['Sync started']);
  });
});

describe('horizons past a day (U4-F4)', () => {
  it('a PR open and waiting for review two days fires once, at 48 hours', () => {
    const r = rule({ title: 'PR waits', when: { type: 'git:pr-status', where: [{ field: 'state', op: 'eq', value: 'OPEN' }, { field: 'reviewState', op: 'eq', value: 'pending' }] }, dwell: { atLeastMin: 2880 }, say: 'PR #{number} waited {minutes} min' });
    expect(r.dwell).toEqual({ atLeastMin: 2880 });
    const events = [{ type: 'git:pr-status', ts: at(0), payload: { number: 7, state: 'OPEN', reviewState: 'pending' } }, ...Array.from({ length: 72 }, (_, h) => tick((h + 1) * 60))];
    expect(backtestWatch(r, events, { daytime: () => true }).fires.map((f) => [f.at, f.text])).toEqual([[at(2880), 'PR #7 waited 2880 min']]);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:pr-status' }, dwell: { atLeastMin: 10081 }, say: 'x' })).toBe(true);
    expect('rule' in validateWatchRule({ title: 't', when: { type: 'git:commit' }, count: { atLeast: 3, withinMin: 10080 }, say: 'x' })).toBe(true);
  });
});

describe('age conditions, weighed again on every tick (U4-F9)', () => {
  const active = (min: number, eventId: string, endMin: number) => ({ type: 'calendar:active', ts: at(min), payload: { event: { eventId, title: `M ${eventId}`, isAllDay: false, endDate: at(endMin) } } });
  const ticks = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => tick(from + i * step));
  it('a meeting past its end by ten minutes fires once per meeting, on the tick it ages into matching', () => {
    const r = rule({ title: 'Overrun', when: { type: 'calendar:active', where: [{ field: 'event.endDate', op: 'ageGt', value: 10 }, { field: 'event.endDate', op: 'ageLt', value: 60 }] }, say: '{event.title} ended over 10 min ago' });
    const events = [active(0, 'm1', 30), ...ticks(1, 120), active(121, 'm2', 150), ...ticks(122, 300)].sort((a, b) => a.ts.localeCompare(b.ts));
    expect(backtestWatch(r, events, { daytime: () => true }).fires.map((f) => [f.at, f.text])).toEqual([
      [at(41), 'M m1 ended over 10 min ago'],
      [at(161), 'M m2 ended over 10 min ago'],
    ]);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'calendar:active', where: [{ field: 'x', op: 'ageGt', value: 'ten' }] }, say: 'x' })).toBe(true);
  });
  it('a stale row holds a fire back without ending the state: the PR is judged only while it is being watched', () => {
    const r = rule({ title: 'PR waits', when: { type: 'git:pr-status', where: [{ field: 'reviewState', op: 'eq', value: 'pending' }, { field: 'timestamp', op: 'ageLt', value: 420 }] }, dwell: { atLeastMin: 2880 }, say: 'PR #{number} waits' });
    const seen = (h: number) => ({ type: 'git:pr-status', ts: at(h * 60), payload: { number: 7, reviewState: 'pending', timestamp: at(h * 60) } });
    // Re-sent every 6 h while its branch is out, then the branch is left for a day and a half.
    const events = [...[0, 6, 12, 18, 24, 30].map(seen), ...ticks(60, 72 * 60, 60), seen(60)].sort((a, b) => a.ts.localeCompare(b.ts));
    const fires = backtestWatch(r, events, { daytime: () => true }).fires;
    expect(fires.map((f) => f.at)).toEqual([at(60 * 60)]); // not at 48 h (unwatched since 30 h), but when seen again, aged from the first sighting
  });
});

describe('then: A, then (not) B about the same thing within T (U4-F13)', () => {
  const ticks = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => tick(from + i * step));
  const mail = (min: number, from: string) => ({ type: 'mail:received', ts: at(min), payload: { from, subject: 'Q' } });
  const sent = (min: number, to: string[]) => ({ type: 'mail:sent', ts: at(min), payload: { to, subject: 'Re: Q' } });
  const noReply = rule({ title: 'No reply', when: { type: 'mail:received' }, by: ['from'], then: { type: 'mail:sent', by: ['to[]'], withinMin: 1440 }, say: 'no reply to {from} in a day' });
  const sorted = (e: { type: string; ts: string; payload: unknown }[]) => e.sort((a, b) => a.ts.localeCompare(b.ts));
  it('mail from someone with no mail back to them in a day fires; a reply clears it', () => {
    expect(noReply.then).toEqual({ type: 'mail:sent', by: ['to[]'], withinMin: 1440, absent: true });
    const events = sorted([mail(0, 'Mira Bakker'), mail(10, 'Tom'), sent(300, ['Tom', 'Ana']), ...ticks(60, 1500, 60)]);
    expect(said(noReply, events)).toEqual(['no reply to Mira Bakker in a day']);
  });
  it('the present form fires only when the second event comes in time', () => {
    const quick = rule({ title: 'Fixed fast', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, then: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'success' }], withinMin: 30, absent: false }, say: '#{number} green again in {minutes} min' });
    const pr = (min: number, number: number, checkState: string) => ({ type: 'git:pr-status', ts: at(min), payload: { number, checkState } });
    expect(said(quick, sorted([pr(0, 1, 'failure'), pr(20, 1, 'success'), pr(0, 2, 'failure'), ...ticks(1, 60), pr(50, 2, 'success')]))).toEqual(['#1 green again in 20 min']);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'mail:received' }, then: { type: 'mail:sent' }, say: 'x' })).toBe(true);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'mail:received' }, then: { type: 'mail:sent', withinMin: 10 }, dwell: { atLeastMin: 5 }, say: 'x' })).toBe(true);
  });
});

describe('count.sum, a running total (U4-F15)', () => {
  it('four 50-minute focus blocks reach three hours at the fourth', () => {
    const r = rule({ title: 'Deep day', when: { type: 'event:focus-flow' }, count: { atLeast: 3 * 3_600_000, withinMin: 720, sum: 'durationMs' }, say: '{count} blocks, {sum} ms of focus' });
    const flow = (min: number) => ({ type: 'event:focus-flow', ts: at(min), payload: { durationMs: 50 * 60_000 } });
    expect(backtestWatch(r, [flow(50), flow(110), flow(170), flow(230)], { daytime: () => true }).fires.map((f) => [f.at, f.text])).toEqual([[at(230), '4 blocks, 12000000 ms of focus']]);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'event:focus-flow' }, count: { atLeast: 3, withinMin: 60, sum: 'durationMs', distinct: 'x' }, say: 'x' })).toBe(true);
  });
});

describe('while — the owner\'s situation (U4-F14)', () => {
  it('a rule for "in a call", and one for "not in a meeting and not away"', () => {
    const inCall = rule({ title: 'Chat in a call', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chat' }] }, while: { call: true }, say: 'chat during a call' });
    const media = (min: number, audioInput: boolean) => ({ type: 'media:state', ts: at(min), payload: { audioInput, camera: false } });
    expect(said(inCall, [win(0, 'Chat'), media(1, true), win(2, 'Chat'), media(3, false), win(4, 'Chat')])).toEqual(['chat during a call']);
    // Sundial's own hearing holding the microphone is not a call.
    const own = { type: 'media:state', ts: at(5), payload: { audioInput: true, audioInputProcess: 'Sundial', camera: false } };
    expect(said(inCall, [own, win(6, 'Chat')])).toEqual([]);
    const free = rule({ title: 'Free', when: { type: 'git:commit' }, while: { meeting: false, away: false }, say: 'commit', cooldownMin: 1 });
    const cal = { type: 'calendar:active', ts: at(10), payload: { event: { eventId: 'm', isAllDay: false, startDate: at(10), endDate: at(40) } } };
    const commit = (min: number) => ({ type: 'git:commit', ts: at(min), payload: {} });
    const idle = { type: 'idle:start', ts: at(50), payload: {} };
    expect(backtestWatch(free, [commit(5), cal, commit(20), commit(45), idle, commit(55)], { daytime: () => true }).fires.map((f) => f.at)).toEqual([at(5), at(45)]);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:commit' }, while: { asleep: true }, say: 'x' })).toBe(true);
  });
});

describe('describeRule', () => {
  it('says a rule in one line', () => {
    expect(describeRule(rule({ title: 'Pile', when: { type: 'git:status', where: [{ field: 'dirtyFiles', op: 'gt', value: 16 }] }, dwell: { atLeastMin: 75 }, say: 'x' }))).toBe('git:status where dirtyFiles > 16: held 75 min, per cwd');
    expect(describeRule(rule({ title: 'PR', when: { type: 'git:pr-status', where: [{ field: 'timestamp', op: 'ageLt', value: 420 }] }, then: { type: 'git:pr-status', withinMin: 2880 }, during: { days: [1, 2, 3, 4, 5] }, say: 'x' }))).toBe('git:pr-status where timestamp less than 420 min ago: then no git:pr-status within 2 d, per number (days 1,2,3,4,5)');
    expect(describeRule(rule({ title: 'Late', when: { type: 'shell:command' }, count: { atLeast: 5, withinMin: 30 }, while: { call: false }, say: 'x' }))).toBe('shell:command: 5 within 30 min (not call)');
  });
});

describe('quiet hours hold a fire until they end (U4-F17)', () => {
  it('a fire at 23:00 is said at the first tick after 08:00, not lost', () => {
    const r = rule({ title: 'CI', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, quiet: { from: '22:00', to: '08:00' }, say: 'CI failed on #{number}' });
    const red = (iso: string, number: number) => ({ type: 'git:pr-status', ts: iso, payload: { number, checkState: 'failure' } });
    const tk = (iso: string) => ({ type: 'clock:tick', ts: iso, payload: {} });
    const out = backtestWatch(r, [red('2026-10-05T23:00:00Z', 1), tk('2026-10-06T07:59:00Z'), tk('2026-10-06T08:00:00Z'), red('2026-10-06T09:00:00Z', 2)], { daytime: () => true, timeZone: 'UTC' }).fires;
    expect(out.map((f) => [f.at, f.text])).toEqual([['2026-10-06T08:00:00Z', 'CI failed on #1'], ['2026-10-06T09:00:00Z', 'CI failed on #2']]);
  });
});

describe('escalation: still so an hour later, said once more as an interruption (U4-F16)', () => {
  const ticks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => tick(from + i));
  it('the second saying carries its own key and a heavier weight; a state that ended cancels it', () => {
    const r = rule({ title: 'Agent waits', when: { type: 'agent:fleet', where: [{ field: 'sessions[].state', op: 'eq', value: 'waiting' }] }, dwell: { atLeastMin: 10 }, escalate: { afterMin: 60 }, say: '{sessions[].id} waits' });
    const fleet = (min: number, state: string) => ({ type: 'agent:fleet', ts: at(min), payload: { sessions: [{ id: 's1', state }] } });
    const fires = backtestWatch(r, [fleet(0, 'waiting'), ...ticks(1, 80)], { daytime: () => true }).fires;
    expect(fires.map((f) => [f.at, f.text])).toEqual([[at(10), 's1 waits'], [at(70), 'Still: s1 waits']]);
    expect(fires[1]!.candidate.key).toBe(`${fires[0]!.candidate.key}:again`);
    expect(fires[1]!.candidate.surprise).toBeGreaterThan(fires[0]!.candidate.surprise);
    const answered = backtestWatch(r, [fleet(0, 'waiting'), ...ticks(1, 30), fleet(31, 'working'), ...ticks(32, 80)], { daytime: () => true }).fires;
    expect(answered.map((f) => f.text)).toEqual(['s1 waits']);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'git:commit' }, count: { atLeast: 2, withinMin: 5 }, escalate: { afterMin: 5 }, say: 'x' })).toBe(true);
  });
});

describe('person: a name resolved to the aliases the record holds, frozen into the spec (U4-F18)', () => {
  it('mail from Mira matches her person-hash sender after resolving, and the fold keeps a plain list', () => {
    const aliases = { 'person-0a1b2c3d4e': 'Mira Bakker', 'person-9f8e7d6c5b': 'Tom', mira: 'Mira Bakker' };
    const spec = resolvePeople({ title: 'Mail from Mira', when: { type: 'mail:received', where: [{ field: 'from', op: 'person', value: 'Mira Bakker' }] }, say: 'mail from Mira' }, aliases);
    const r = rule(spec as Record<string, unknown>);
    expect(r.when.where).toEqual([{ field: 'from', op: 'in', value: ['Mira Bakker', 'person-0a1b2c3d4e', 'mira'] }]);
    const mail = (min: number, from: string) => ({ type: 'mail:received', ts: at(min), payload: { from } });
    expect(backtestWatch(r, [mail(0, 'person-0a1b2c3d4e'), mail(1, 'person-9f8e7d6c5b'), mail(90, 'Mira Bakker')], { daytime: () => true }).fires.map((f) => f.at)).toEqual([at(0), at(90)]);
    expect('error' in validateWatchRule({ title: 't', when: { type: 'mail:received', where: [{ field: 'from', op: 'person', value: 'Mira' }] }, say: 'x' })).toBe(true);
  });
});

describe('isRuleIntent — "tell me when" is a rule (U4-F29)', () => {
  it('routes standing asks in English and Dutch, and not questions or one-off reminders', () => {
    for (const t of ['Tell me when a PR waits more than two days', 'let me know if CI fails on main', 'Ping me whenever an agent waits on me', 'every time I get mail from Mira, tell me', 'Laat me weten als de build faalt', 'Laat het me even weten wanneer Tom mailt', 'zodra de PR gemerged is, meld het', 'Waarschuw me als ik te lang in Slack zit', 'geef me een seintje wanneer het klaar is', 'Elke keer als de tests falen'])
      expect(isRuleIntent(t)).toBe(true);
    for (const t of ['When did I last commit?', 'Remind me at four to call Tom', 'What happened when the build failed?', 'tell me about my week', 'Wanneer was mijn laatste meeting?'])
      expect(isRuleIntent(t)).toBe(false);
  });
});

describe('blueprints: a rule\'s shape to share (U4-F30)', () => {
  it('lifts every value into an input, drops the id, and fills back into a valid spec', () => {
    const r = rule({ title: 'Pile', when: { type: 'git:status', where: [{ field: 'cwd', op: 'contains', value: 'puzzlebox-studio' }, { field: 'dirtyFiles', op: 'gt', value: 16 }] }, dwell: { atLeastMin: 75 }, say: '{cwd} has {dirtyFiles} files' });
    const { blueprint, inputs } = toBlueprint(r);
    expect(JSON.stringify(blueprint)).not.toContain('puzzlebox');
    expect(blueprint.id).toBeUndefined();
    expect(inputs).toEqual([{ name: 'cwd', field: 'cwd', op: 'contains', example: 'string' }, { name: 'dirtyFiles', field: 'dirtyFiles', op: 'gt', example: 'number' }]);
    const back = validateWatchRule(fromBlueprint(blueprint, { cwd: 'my-repo', dirtyFiles: 10 }));
    expect('rule' in back && back.rule.when.where).toEqual([{ field: 'cwd', op: 'contains', value: 'my-repo' }, { field: 'dirtyFiles', op: 'gt', value: 10 }]);
  });
});
