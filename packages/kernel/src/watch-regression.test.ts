import { describe, it, expect } from 'vitest';
import { backtestTypes, backtestWatch, validateWatchRule, type WatchRule } from './watch.js';

/*
 * The thirteen owner-style rules of the UC4 report (docs/release/09-use-cases/
 * 4-watch-rules.md §3), each over a made-up log that holds the trap the live
 * record showed, with the fires a person would call right pinned. Six of them
 * were silently wrong on the old grammar (1b, 4, 6, 7, 10, 11); where the old
 * spec itself is now right, it is pinned too.
 */

type Ev = { type: string; ts: string; payload: unknown };
const T0 = Date.parse('2026-10-05T00:00:00.000Z'); // a Monday
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const e = (type: string, min: number, payload: Record<string, unknown> = {}): Ev => ({ type, ts: at(min), payload });
const ticks = (from: number, to: number, step = 1): Ev[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => e('clock:tick', from + i * step));
const rule = (spec: Record<string, unknown>): WatchRule => {
  const out = validateWatchRule(spec);
  if ('error' in out) throw new Error(out.error);
  return out.rule;
};
/** Replays only what the backtest would fetch, in order, and returns [minute, sentence] per fire. */
function fires(r: WatchRule, events: Ev[], timeZone = 'UTC'): [number, string][] {
  const types = new Set(backtestTypes(r));
  const log = events.filter((x) => types.has(x.type)).sort((a, b) => a.ts.localeCompare(b.ts));
  const day = (ts: string) => new Date(ts).getUTCHours() >= 6 && new Date(ts).getUTCHours() < 18;
  return backtestWatch(r, log, { daytime: day, timeZone }).fires.map((f) => [Math.round((Date.parse(f.at) - T0) / 60_000), f.text]);
}

describe('UC4 §3 regression: the thirteen rules, pinned', () => {
  it('1 · a PR waits more than two days for review: once, at 48 h, and only while it is still being watched', () => {
    const r = rule({ title: 'PR waits', when: { type: 'git:pr-status', where: [{ field: 'state', op: 'eq', value: 'OPEN' }, { field: 'reviewState', op: 'eq', value: 'pending' }, { field: 'timestamp', op: 'ageLt', value: 420 }] }, dwell: { atLeastMin: 2880 }, say: 'PR #{number} has waited {minutes} min for a first review' });
    const pr = (h: number, number: number, reviewState: string) => e('git:pr-status', h * 60, { number, state: 'OPEN', reviewState, timestamp: at(h * 60) });
    const log = [
      ...Array.from({ length: 13 }, (_, i) => pr(i * 6, 7, 'pending')), // re-sent every 6 h for three days
      pr(0, 8, 'pending'),
      pr(20, 8, 'approved'), // reviewed within a day
      pr(1, 9, 'pending'), // seen once, its branch never checked out again: unknown, not waiting
      ...ticks(0, 72 * 60, 10),
    ];
    expect(fires(r, log)).toEqual([[2880, 'PR #7 has waited 2880 min for a first review']]);
  });

  it('1b · a PR waits a day: each PR its own stretch, never carried across PRs', () => {
    const old = rule({ title: 'PR waits a day', when: { type: 'git:pr-status', where: [{ field: 'state', op: 'eq', value: 'OPEN' }, { field: 'reviewState', op: 'eq', value: 'pending' }] }, dwell: { atLeastMin: 1440 }, say: 'PR #{number} waits' });
    const log = [e('git:pr-status', 0, { number: 1, state: 'OPEN', reviewState: 'pending' }), e('git:pr-status', 300, { number: 2, state: 'OPEN', reviewState: 'approved' }), e('git:pr-status', 900, { number: 3, state: 'OPEN', reviewState: 'pending' }), e('git:pr-status', 1000, { number: 3, state: 'MERGED', reviewState: 'approved' }), ...ticks(0, 1500, 10)];
    expect(fires(old, log)).toEqual([[1440, 'PR #1 waits']]); // the old spec, grouped by number by default
    expect(fires({ ...old, by: [] }, log)).toEqual([]); // one stream: PR 2's approval ended PR 1's wait
  });

  it('2 · CI failed on my PR: once per failure, per PR; a re-sent red is the same red', () => {
    const r = rule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}' });
    const pr = (min: number, number: number, checkState: string) => e('git:pr-status', min, { number, checkState });
    expect(fires(r, [pr(0, 1, 'failure'), pr(10, 1, 'failure'), pr(20, 1, 'failure'), pr(30, 2, 'failure'), pr(90, 1, 'success'), pr(200, 1, 'failure')])).toEqual([
      [0, 'CI failed on #1'],
      [30, 'CI failed on #2'],
      [200, 'CI failed on #1'],
    ]);
  });

  it('3 · the shell keeps failing: four in ten minutes in one folder, not across folders', () => {
    const r = rule({ title: 'Shell failing', when: { type: 'shell:command', where: [{ field: 'exitCode', op: 'gt', value: 0 }] }, by: ['cwd'], count: { atLeast: 4, withinMin: 10 }, say: '{count} failures in {cwd}' });
    const cmd = (min: number, cwd: string, exitCode = 1) => e('shell:command', min, { cwd, exitCode });
    expect(fires(r, [cmd(0, '/a'), cmd(1, '/b'), cmd(2, '/a'), cmd(3, '/b'), cmd(4, '/b', 0), cmd(5, '/a'), cmd(6, '/b'), cmd(7, '/a')])).toEqual([[7, '4 failures in /a']]);
  });

  it('4 · a meeting ran over: the call still on ten minutes past the end, once per meeting', () => {
    const r = rule({ title: 'Overrun', when: { type: 'calendar:active', where: [{ field: 'event.endDate', op: 'ageGt', value: 10 }, { field: 'event.endDate', op: 'ageLt', value: 60 }, { field: 'event.isAllDay', op: 'ne', value: true }] }, while: { call: true }, say: '{event.title} ran over' });
    const meeting = (min: number, id: string, end: number) => e('calendar:active', min, { event: { eventId: id, title: `Sync ${id}`, isAllDay: false, startDate: at(min), endDate: at(end) } });
    const mic = (min: number, on: boolean, app = 'Meet') => e('media:state', min, { audioInput: on, audioInputProcess: on ? app : null, camera: false });
    const log = [
      meeting(0, 'a', 30), mic(0, true), mic(50, false), // ran over by twenty minutes
      meeting(100, 'b', 130), mic(100, true), mic(131, false), // ended on time
      meeting(200, 'c', 230), mic(232, true, 'Sundial'), // Sundial listening is not a call
      ...ticks(0, 300),
    ];
    expect(fires(r, log)).toEqual([[41, 'Sync a ran over']]);
  });

  it('5 · twenty minutes in the chat app, counted while at the machine', () => {
    const r = rule({ title: 'Chat dwell', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chat' }] }, dwell: { atLeastMin: 20, clock: 'active' }, say: 'chat for {minutes} min' });
    const log = [e('window:changed', 0, { processName: 'Chat' }), e('window:changed', 25, { processName: 'Code' }), e('window:changed', 100, { processName: 'Chat' }), e('idle:start', 105), e('idle:end', 200), ...ticks(0, 220)];
    expect(fires(r, log)).toEqual([
      [20, 'chat for 20 min'],
      [215, 'chat for 20 min'], // five minutes before the idle stretch, fifteen after it
    ]);
  });

  it('6 · no commit for six hours: six hours at the machine, never the night', () => {
    const old = rule({ title: 'No commits', when: { type: 'git:commit' }, absent: { forMin: 360 }, say: 'no commit for {minutes} min' });
    const log: Ev[] = [];
    for (let d = 0; d < 3; d++) {
      const o = d * 1440 + 480; // awake 08:00–23:00
      log.push(e('system:sleep-wake', o, { kind: 'wake' }), ...ticks(o, o + 900), e('git:commit', o + 60), e('git:commit', o + 180), e('git:commit', o + 780), e('system:sleep-wake', o + 900, { kind: 'sleep' }));
    }
    // 11:00 → 17:00 on each day. 21:00 → 23:00 and 08:00 → 09:00 are three hours at the machine: the night is not counted, so no morning fire.
    expect(fires(old, log)).toEqual([
      [1020, 'no commit for 360 min'],
      [2460, 'no commit for 360 min'],
      [3900, 'no commit for 360 min'],
    ]);
  });

  it('7 · an agent waiting on me ten minutes: per session, even while another one always waits', () => {
    const r = rule({ title: 'Agent waits', when: { type: 'agent:fleet', where: [{ field: 'sessions[].state', op: 'eq', value: 'waiting' }] }, dwell: { atLeastMin: 10 }, say: '{sessions[].branch} waits for you' });
    const fleet = (min: number, s1: string) => e('agent:fleet', min, { sessions: [{ id: 's0', branch: 'old-work', state: 'waiting' }, { id: 's1', branch: 'fix-login', state: s1 }] });
    const log = [fleet(0, 'working'), fleet(30, 'waiting'), fleet(35, 'waiting'), fleet(38, 'working'), fleet(50, 'waiting'), ...ticks(0, 70)];
    const want: [number, string][] = [[10, 'old-work waits for you'], [60, 'fix-login waits for you']];
    expect(fires(r, log)).toEqual(want);
    // The old stringified hack, now fanned out per session by default, says the same.
    const hack = rule({ title: 'Agent waits', when: { type: 'agent:fleet', where: [{ field: 'sessions', op: 'contains', value: '"state":"waiting"' }] }, dwell: { atLeastMin: 10 }, say: '{sessions.branch} waits for you' });
    expect(fires(hack, log)).toEqual(want);
  });

  it('8 · late-night coding: five commands in half an hour after 22:00 in the owner\'s zone', () => {
    const r = rule({ title: 'Late coding', when: { type: 'shell:command' }, during: { from: '22:00', to: '04:00' }, count: { atLeast: 5, withinMin: 30 }, say: '{count} commands late' });
    // 19:00Z is 21:00 in Berlin summer time; 20:10Z is 22:10.
    const log = [...[1140, 1142, 1144, 1146, 1148].map((m) => e('shell:command', m, { exitCode: 0 })), ...[1210, 1212, 1214, 1216, 1218].map((m) => e('shell:command', m, { exitCode: 0 }))];
    expect(fires(r, log, 'Europe/Berlin')).toEqual([[1218, '5 commands late']]);
  });

  it('9 · mail from anyone, live only: a cooldown per sender, not one for all mail', () => {
    const r = rule({ title: 'Mail', when: { type: 'mail:received', where: [{ field: 'from', op: 'matches', value: '.' }, { field: 'backfill', op: 'exists', value: false }] }, by: ['from'], cooldownMin: 30, say: 'mail from {from}' });
    const mail = (min: number, from: string, backfill?: boolean) => e('mail:received', min, { from, subject: 's', ...(backfill ? { backfill } : {}) });
    expect(fires(r, [mail(0, 'Mira Bakker'), mail(5, 'Tom'), mail(10, 'Mira Bakker'), mail(12, 'Ana', true), mail(40, 'Mira Bakker')])).toEqual([
      [0, 'mail from Mira Bakker'],
      [5, 'mail from Tom'],
      [40, 'mail from Mira Bakker'],
    ]);
  });

  it('9b · mail from a domain stays out of reach: senders are sanitized at ingest, by design', () => {
    const r = rule({ title: 'Domain', when: { type: 'mail:received', where: [{ field: 'from', op: 'contains', value: '@' }] }, say: 'x' });
    expect(fires(r, [e('mail:received', 0, { from: 'person-0a1b2c3d4e' }), e('mail:received', 1, { from: 'Mira Bakker' })])).toEqual([]);
  });

  it('10 · back-to-back meetings: three different meetings in three hours, re-sends and all-day entries left out', () => {
    const r = rule({ title: 'Back to back', when: { type: 'calendar:active', where: [{ field: 'event.isAllDay', op: 'ne', value: true }] }, count: { atLeast: 3, withinMin: 180 }, say: '{count} meetings in three hours' });
    const m = (min: number, id: string, isAllDay = false) => e('calendar:active', min, { event: { eventId: id, isAllDay } });
    const resent = Array.from({ length: 100 }, (_, i) => m(i, 'a'));
    expect(fires(r, [...resent, m(120, 'b'), m(170, 'c'), m(600, 'd', true), m(601, 'e', true), m(602, 'f', true)])).toEqual([[170, '3 meetings in three hours']]);
    // The old spec on context events: a hundred re-sends of one entry are one entry now.
    const old = rule({ title: 'Back to back', when: { type: 'calendar:context-event', where: [{ field: 'kind', op: 'eq', value: 'meeting' }] }, count: { atLeast: 3, withinMin: 180 }, say: '{count}' });
    expect(fires(old, Array.from({ length: 100 }, (_, i) => e('calendar:context-event', i, { kind: 'meeting', event: { eventId: 'a' } })))).toEqual([]);
  });

  it('11 · the adopted uncommitted-pile rule: the dirty repo fires though other repos report clean', () => {
    const adopted = rule({ title: 'Uncommitted pile sitting an hour', when: { type: 'git:status', where: [{ field: 'dirtyFiles', op: 'gt', value: 16 }] }, say: '{cwd} has {dirtyFiles} uncommitted files on {branch}, untouched for {minutes} minutes', cooldownMin: 360, dwell: { atLeastMin: 75 } });
    const st = (min: number, cwd: string, dirtyFiles: number) => e('git:status', min, { cwd, branch: 'main', dirtyFiles });
    const log: Ev[] = [st(0, '/r/puzzlebox-studio', 20)];
    for (let m = 3; m <= 120; m += 3) log.push(st(m, m % 2 ? '/r/other' : '/r/third', 0));
    log.push(st(60, '/r/puzzlebox-studio', 21), ...ticks(0, 120));
    expect(fires(adopted, log)).toEqual([[75, '/r/puzzlebox-studio has 21 uncommitted files on main, untouched for 75 minutes']]);
  });

  it('12 · a thrashing burst: three in half an hour', () => {
    const r = rule({ title: 'Thrashing', when: { type: 'event:thrashing', where: [{ field: 'switchCount', op: 'gt', value: 8 }] }, count: { atLeast: 3, withinMin: 30 }, say: '{count} bursts' });
    const burst = (min: number, switchCount: number) => e('event:thrashing', min, { switchCount });
    expect(fires(r, [burst(0, 9), burst(10, 4), burst(20, 12), burst(25, 10), burst(200, 9)])).toEqual([[25, '3 bursts']]);
  });

  it('13 · an unread pile-up for an hour at the machine, not overnight', () => {
    const r = rule({ title: 'Unread', when: { type: 'event:notification', where: [{ field: 'totalCount', op: 'gt', value: 20 }] }, dwell: { atLeastMin: 60, clock: 'active' }, say: '{totalCount} unread' });
    const log = [e('event:notification', 0, { totalCount: 25 }), e('idle:start', 20), e('idle:end', 600), ...ticks(0, 700)];
    expect(fires(r, log)).toEqual([[640, '25 unread']]);
    expect(fires({ ...r, dwell: { atLeastMin: 60 } }, log)).toEqual([[60, '25 unread']]); // the wall clock: an hour of the owner away
  });
});

describe('rules over Gnomon\'s own verdicts (U4-F34)', () => {
  it('"tell me if I mark three notices wrong in a day" fires on the third', () => {
    const r = rule({ title: 'Too many wrong', when: { type: 'feedback:verdict', where: [{ field: 'verdict', op: 'eq', value: 'wrong' }] }, count: { atLeast: 3, withinMin: 1440 }, say: '{count} notices marked wrong today' });
    const v = (min: number, verdict: string) => e('feedback:verdict', min, { artifactKind: 'notice', artifactId: `k${min}`, verdict });
    expect(fires(r, [v(0, 'wrong'), v(60, 'useful'), v(120, 'wrong'), v(300, 'wrong')])).toEqual([[300, '3 notices marked wrong today']]);
  });
});
