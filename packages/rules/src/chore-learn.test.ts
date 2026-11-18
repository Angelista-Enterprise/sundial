// Round 5: the chore learner. Every value is made up (hosts, tickets, times).
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { knownHostChores } from '@sundial/kernel/read/chores.js';
import type { Effect, KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { byGnomon } from './by-gnomon.js';
import { MAX_CHORE_DAYS, MAX_CHORES, choreLearn, choresCleared, foldChoreRows } from './chore-learn.js';
import { RULE_MANIFEST } from './manifest.js';
import { noticeGate } from './notice-gate.js';

// 2026-03-02 is a Monday; the zone is UTC, so a local day is the ISO date.
const MONDAY = Date.parse('2026-03-02T00:00:00.000Z');
/** The n-th workday from that Monday (0-based), at hh:mm. */
const workday = (n: number, hh = 9, mm = 0) => new Date(MONDAY + (Math.floor(n / 5) * 7 + (n % 5)) * 86_400_000 + (hh * 60 + mm) * 60_000).toISOString();
let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const tab = (ts: string, host: string, title = 'Inbox') => ev('browser:tab', ts, { host, app: 'Arc', title, url: `https://${host}/` });
const opened = (ts: string, id: string) => ev('document:opened', ts, { kind: 'jira-ticket', id, title: `${id} something`, sourceApp: 'Arc' });
const base = (over: Partial<KernelState['config']> = {}): KernelState => {
  const s = createInitialState('d');
  return { ...s, config: { ...s.config, timezone: 'UTC', ...over } };
};
const run = (events: SanitizedEvent[], state = base(), rule: Rule = choreLearn) => {
  const effects: Effect[] = [];
  const out = events.reduce((s, e) => {
    const r = rule(s, e);
    effects.push(...r.effects);
    return r.state;
  }, state);
  return { state: out, effects };
};
const emitted = (effects: Effect[], type: string) => effects.flatMap((e) => (e.type === 'EmitEvent' && e.event.type === type ? [e.event] : []));
/** A morning sweep on workday n: the mail host at 09:00, the code host at 09:20. */
const sweep = (n: number) => [tab(workday(n, 9, 0), 'mail.example.com'), tab(workday(n, 9, 20), 'github.com')];

describe('choreLearn: counting', () => {
  it('counts distinct workday mornings per site, with the first visit\'s minute; a second visit, an afternoon or a weekend adds nothing', () => {
    const saturday = new Date(MONDAY + 5 * 86_400_000 + 9 * 3_600_000).toISOString();
    const { state } = run([tab(workday(0, 9, 5), 'mail.example.com'), tab(workday(0, 10, 0), 'mail.example.com'), tab(workday(0, 14, 0), 'wiki.example.com'), tab(saturday, 'wiki.example.com'), tab(workday(1, 8, 45), 'mail.example.com')]);
    expect(state.chores?.keys).toEqual({ 'host:mail.example.com': { days: ['2026-03-02', '2026-03-03'], minutes: [545, 525] } });
  });

  it('counts a ticket page opened on any day, once a day', () => {
    const { state } = run([opened(workday(0, 15), 'BOX-484'), opened(workday(0, 16), 'BOX-484'), ev('document:opened', workday(0, 16), { kind: 'github-pr', id: '12' })]);
    expect(state.chores?.keys).toEqual({ 'ticket:BOX-484': { days: ['2026-03-02'], minutes: [900] } });
  });

  it('owner rows only: a tab Gnomon caused with its own act, or in the rig\'s test window, never counts', () => {
    const fenced = RULE_MANIFEST.find((r) => r.name === 'choreLearn')!;
    const both: Rule = (s, e) => fenced(byGnomon(s, e).state, e);
    const act = [ev('action:decided', workday(0, 9, 0), { tool: 'screen_act', verdict: 'allow' }), tab(workday(0, 9, 0).replace(':00.000Z', ':01.000Z'), 'mail.example.com')];
    const rig = [tab(workday(1, 9, 0), 'mail.example.com', 'Rig fixture: inbox')];
    expect(run([...act, ...rig], base(), both).state.chores).toBeUndefined();
    // The same tab with no act around it, and a plain title, is the owner's.
    expect(run([tab(workday(2, 9, 0), 'mail.example.com')], base(), both).state.chores?.keys['host:mail.example.com']?.days).toEqual(['2026-03-04']);
  });

  it('rebuilt from history rows (a boot whose snapshot holds none): the same counters the manifest folds, offers unsaid, a "not again" kept', () => {
    const fenced = RULE_MANIFEST.find((r) => r.name === 'choreLearn')!;
    const both: Rule = (s, e) => fenced(byGnomon(s, e).state, e);
    const act = [ev('action:decided', workday(0, 9, 0), { tool: 'screen_act', verdict: 'allow' }), tab(workday(0, 9, 0).replace(':00.000Z', ':01.000Z'), 'mail.example.com')];
    const rows = [...act, tab(workday(1, 9, 0), 'mail.example.com', 'Rig fixture: inbox'), ...[2, 3, 4, 5].flatMap(sweep), opened(workday(5, 15), 'BOX-484')];
    const live = run(rows, base(), both).state.chores!;
    const held = { ...base(), chores: { keys: {}, offered: {}, crossed: null, dismissed: ['tickets'] } };
    const rebuilt = foldChoreRows(choresCleared(held), rows).chores!;
    expect(rebuilt.keys).toEqual(live.keys);
    expect(rebuilt.keys['host:mail.example.com']?.days).toHaveLength(4);
    expect(rebuilt.dismissed).toEqual(['tickets']);
  });

  it('is bounded: at most 64 keys, at most 14 days each, and a known chore outlives the newcomers', () => {
    const habit = Array.from({ length: 20 }, (_, n) => tab(workday(n), 'mail.example.com'));
    const crowd = Array.from({ length: MAX_CHORES + 20 }, (_, i) => tab(workday(19, 10, i % 60).replace('T10', `T${10 + Math.floor(i / 60)}`), `site-${i}.example.com`));
    const { state } = run([...habit, ...crowd]);
    expect(Object.keys(state.chores!.keys)).toHaveLength(MAX_CHORES);
    expect(state.chores!.keys['host:mail.example.com']!.days).toHaveLength(MAX_CHORE_DAYS);
    expect(state.chores!.keys['host:mail.example.com']!.minutes).toHaveLength(MAX_CHORE_DAYS);
  });

  it('a day boundary drops the days past four weeks, and a key with none left', () => {
    const { state } = run([tab(workday(0), 'mail.example.com'), tab(workday(25), 'github.com'), ev('day:boundary', workday(26, 0, 1), {})]);
    expect(Object.keys(state.chores!.keys)).toEqual(['host:github.com']);
  });
});

describe('choreLearn: the offer', () => {
  it('needs k distinct days (choreDays, default 3) before the day\'s first known site offers the pull requests', () => {
    const two = run([...sweep(0), ...sweep(1), tab(workday(2, 9, 0), 'mail.example.com')]);
    expect(emitted(two.effects, 'notice:candidate')).toEqual([]);
    const three = run([...sweep(0), ...sweep(1), ...sweep(2), tab(workday(3, 9, 0), 'mail.example.com')]);
    const [candidate] = emitted(three.effects, 'notice:candidate');
    expect(candidate?.payload).toMatchObject({ shape: 'anticipatory', kind: 'chore', key: 'chore:prs', offer: { tool: 'gnomon_pull_requests', args: {}, label: 'Show the pull requests' } });
    expect(String(candidate?.payload.observation)).toContain('github.com most workday mornings (3 in the last four weeks), usually around 09:20');
    expect(emitted(three.effects, 'chore:offered').map((e) => e.payload)).toEqual([expect.objectContaining({ key: 'host:github.com', days: 3, noticeKey: 'chore:prs', tool: 'gnomon_pull_requests' })]);
    // Config raises the bar.
    expect(emitted(run([...sweep(0), ...sweep(1), ...sweep(2), tab(workday(3, 9, 0), 'mail.example.com')], base({ choreDays: 4 })).effects, 'notice:candidate')).toEqual([]);
  });

  it('one offer a day: a second known site the same morning offers nothing; the next morning offers again', () => {
    const days = [0, 1, 2].flatMap((n) => [...sweep(n), tab(workday(n, 9, 10), 'cal.example.com')]);
    const today = run([...days, tab(workday(3, 9, 0), 'mail.example.com'), tab(workday(3, 9, 5), 'cal.example.com')]);
    expect(emitted(today.effects, 'notice:candidate')).toHaveLength(1);
    expect(emitted(run([tab(workday(4, 9, 0), 'cal.example.com')], today.state).effects, 'notice:candidate')).toHaveLength(1);
  });

  it('no offer when the morning starts on the code host, or once it was visited today', () => {
    const known = run([...sweep(0), ...sweep(1), ...sweep(2)]).state;
    expect(emitted(run([tab(workday(3, 9, 0), 'github.com'), tab(workday(3, 9, 5), 'mail.example.com')], known).effects, 'notice:candidate')).toEqual([]);
  });

  it('the trigger is an event: ticks and boundaries never offer, and the same events give the same offer', () => {
    const known = run([...sweep(0), ...sweep(1), ...sweep(2)]).state;
    expect(run([ev('clock:tick', workday(3, 9, 0), {}), ev('day:boundary', workday(3, 0, 0), {}), ev('owner:first-touch', workday(3, 9, 0), { day: '2026-03-05' })], known).effects).toEqual([]);
    const trigger = tab(workday(3, 9, 0), 'mail.example.com');
    expect(choreLearn(known, trigger)).toEqual(choreLearn(known, trigger));
    expect(emitted(choreLearn(known, trigger).effects, 'notice:candidate')[0]?.ts).toBe(trigger.ts);
  });

  it('the offer rides the gate into notices.offers, where a press finds it', () => {
    const known = run([...sweep(0), ...sweep(1), ...sweep(2)]).state;
    const [candidate] = emitted(choreLearn(known, tab(workday(3, 9, 0), 'mail.example.com')).effects, 'notice:candidate');
    const gated = noticeGate(known, { ...candidate!, sanitized: true });
    expect(gated.state.notices.offers?.['chore:prs']).toMatchObject({ tool: 'gnomon_pull_requests', kind: 'chore' });
    expect(gated.effects.find((e) => e.type === 'Notify')).toMatchObject({ channel: 'tonic-notice', payload: { offer: 'Show the pull requests' } });
  });

  it('Set 5 R3: the offer carries its n into notices.offers; "Not again" on the proposals card stops that offer for good, not the other', () => {
    const known = run([...sweep(0), ...sweep(1), ...sweep(2)]).state;
    const [candidate] = emitted(choreLearn(known, tab(workday(3, 9, 0), 'mail.example.com')).effects, 'notice:candidate');
    expect(noticeGate(known, { ...candidate!, sanitized: true }).state.notices.offers?.['chore:prs']).toMatchObject({ n: 3 });
    const no = run([ev('proposal:answered', workday(2, 18), { kind: 'chore', key: 'prs', verdict: 'dismissed' })], known);
    expect(no.state.chores?.dismissed).toEqual(['prs']);
    expect(emitted(run([tab(workday(3, 9, 0), 'mail.example.com'), tab(workday(4, 9, 0), 'mail.example.com')], no.state).effects, 'notice:candidate')).toEqual([]);
    expect(run([ev('proposal:answered', workday(2, 18), { kind: 'app-note', key: 'prs', verdict: 'dismissed' })], known).state).toBe(known);
  });

  it('the day\'s first ticket offers the known tickets that were also open a week ago today, not the rest', () => {
    // BOX-1 on three days a week apart; BOX-2 on three days but never on a Monday; BOX-3 on one Monday only.
    const history = [
      ...[0, 5, 10].map((n) => opened(workday(n, 15), 'BOX-1')),
      ...[1, 6, 11].map((n) => opened(workday(n, 15), 'BOX-2')),
      opened(workday(10, 16), 'BOX-3'),
    ];
    const monday = run([...history, opened(workday(15, 10), 'BOX-9'), opened(workday(15, 11), 'BOX-2')]);
    const offers = emitted(monday.effects, 'notice:candidate');
    expect(offers).toHaveLength(1);
    expect(offers[0]?.payload).toMatchObject({ kind: 'chore', key: 'chore:tickets', offer: { tool: 'gnomon_tickets', args: { ids: ['BOX-1'] }, label: 'Show the ticket' } });
    expect(String(offers[0]?.payload.observation)).toBe('The ticket you come back to on Mondays: BOX-1.');
    expect(emitted(monday.effects, 'chore:offered')[0]?.payload).toMatchObject({ key: 'tickets', days: 3, items: ['BOX-1'] });
  });

  it('a host chore reaching its count is the rule miner\'s seed; a ticket is not', () => {
    const two = run([...sweep(0), ...sweep(1)]).state;
    expect(two.chores?.crossed).toBeNull();
    const three = run(sweep(2), two).state;
    expect(three.chores?.crossed).toEqual({ key: 'host:github.com', days: 3, at: workday(2, 9, 20) });
    expect(knownHostChores(three, '2026-03-04')).toEqual([{ host: 'mail.example.com', days: 3, minute: 540 }, { host: 'github.com', days: 3, minute: 560 }]);
    expect(run([0, 1, 2].map((n) => opened(workday(n, 15), 'BOX-1'))).state.chores?.crossed).toBeNull();
  });
});
