import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { watchRules } from './watch-rules.js';
import { DEFAULT_GATE_POLICY, applyDelivery, decide, noticeGate, type NoticeState } from './notice-gate.js';
import type { NoticeCandidate } from '@sundial/kernel/types.js';
import { backtestTypes, backtestWatch, emptyWatchFlags, stepWatchFlags, validateWatchRule } from '@sundial/kernel/watch.js';
import { deriveId } from '@sundial/helpers/derive-id.js';

let seq = 0;
const at = (min: number) => new Date(Date.parse('2026-09-28T09:00:00.000Z') + min * 60_000).toISOString();
const ev = (type: string, payload: Record<string, unknown>, min: number): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(min), payload, sanitized: true });
const spec = { title: 'Slack burst', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Slack' }] }, count: { atLeast: 2, withinMin: 10 }, say: '{count} Slack checks in a row' };

function run(events: SanitizedEvent[], state: KernelState = createInitialState('d')) {
  const cands: Record<string, unknown>[] = [];
  for (const e of events) {
    const out = watchRules(state, e);
    state = out.state;
    for (const x of out.effects as { type: string; event?: SanitizedEvent }[]) if (x.type === 'EmitEvent') cands.push(x.event!.payload as Record<string, unknown>);
  }
  return { state, cands };
}

describe('watchRules', () => {
  it('adopts a spec from the log and speaks through a notice candidate', () => {
    const { state, cands } = run([ev('rule:adopted', { rule: spec }, 0), ev('window:changed', { processName: 'Slack' }, 1), ev('window:changed', { processName: 'Slack' }, 2)]);
    expect(state.watch?.rules.map((r) => r.id)).toEqual(['slack-burst']);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ kind: 'watch:slack-burst', observation: '2 Slack checks in a row' });
  });
  it('ignores a bad spec in the log and drops by id', () => {
    const { state } = run([ev('rule:adopted', { rule: { title: 'x' } }, 0), ev('rule:adopted', { rule: spec }, 1), ev('rule:dropped', { id: 'slack-burst' }, 2)]);
    expect(state.watch).toMatchObject({ rules: [], runtime: {}, stats: {}, paused: [] });
  });
  it('does nothing and allocates nothing with no rules', () => {
    const s = createInitialState('d');
    expect(watchRules(s, ev('window:changed', { processName: 'Slack' }, 0)).state).toBe(s);
  });
  it('a rule proposed on the shelf is adopted by the owner\'s Keep, and thrown away by Wrong', () => {
    const shelved = ev('work:shelved', { title: 'Rule idea: Slack burst', body: 'b', jobId: 'j', rule: spec }, 0);
    const entry = deriveId(shelved.ts, shelved.id, 'shelf');
    const kept = run([shelved, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'useful' }, 1)]);
    expect(kept.state.watch?.proposed).toEqual({});
    const out = watchRules(run([shelved]).state, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'useful' }, 1));
    expect(out.effects).toEqual([expect.objectContaining({ type: 'EmitEvent', event: expect.objectContaining({ type: 'rule:adopted', payload: { rule: expect.objectContaining({ id: 'slack-burst' }), via: entry } }) })]);
    const wrong = watchRules(run([shelved]).state, ev('feedback:verdict', { artifactKind: 'knowledge_entry', artifactId: entry, verdict: 'wrong' }, 1));
    expect(wrong.effects).toEqual([]);
    expect(wrong.state.watch?.proposed).toEqual({});
  });
  it('a 21st rule is ignored like the adopt tool refuses it; the oldest stays, and replacing one still works', () => {
    const adopt = (i: number) => ev('rule:adopted', { rule: { ...spec, id: `r${i}`, title: `R ${i}` } }, i);
    const full = run(Array.from({ length: 21 }, (_, i) => adopt(i)));
    expect(full.state.watch?.rules.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i}`));
    const replaced = run([ev('rule:adopted', { rule: { ...spec, id: 'r0', title: 'R 0 again' } }, 30)], full.state);
    expect(replaced.state.watch?.rules.find((r) => r.id === 'r0')?.title).toBe('R 0 again');
  });
  it('keys habituation per entity: the fields the say names tell one PR from another; a say with none keeps the rule key', () => {
    const ci = { title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', cooldownMin: 1 };
    const pr = (n: number, min: number, checkState = 'failure') => ev('git:pr-status', { number: n, checkState }, min);
    // A PR is its own thing (by number): it fires again after it went green and red again.
    const { cands } = run([ev('rule:adopted', { rule: ci }, 0), pr(812, 1), pr(813, 3), pr(812, 4, 'success'), pr(812, 5)]);
    const keys = cands.map((c) => c.key as string);
    expect(keys[0]).toMatch(/^watch:ci-failed:[0-9a-f]{10}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    const burst = run([ev('rule:adopted', { rule: spec }, 0), ev('window:changed', { processName: 'Slack' }, 1), ev('window:changed', { processName: 'Slack' }, 2)]);
    expect(burst.cands[0]?.key).toBe('watch:slack-burst');
  });
  it('an owner rule speaks at dial 0: phasic in a quiet moment, held while typing, and past the cap it joins the list', () => {
    const ci = { title: 'CI failed', when: { type: 'git:pr-status' }, say: 'CI failed on #{number}', cooldownMin: 1 };
    const { cands } = run([ev('rule:adopted', { rule: ci }, 0), ...[1, 2, 3, 4, 5, 6, 7].map((n) => ev('git:pr-status', { number: n }, n * 2))]);
    let gate: NoticeState = { habituation: {}, day: '2026-09-28', spentToday: 0, phasicToday: 0 };
    const channels: string[] = [];
    for (const c of cands as unknown as NoticeCandidate[]) {
      const d = decide(DEFAULT_GATE_POLICY, gate, c, at(30), '2026-09-28', 0.4);
      channels.push(d.channel);
      if (d.channel === 'phasic' || d.channel === 'tonic') gate = { ...applyDelivery(gate, c, at(30), '2026-09-28', d.channel, DEFAULT_GATE_POLICY), phasicToday: (gate.phasicToday ?? 0) + (d.channel === 'phasic' ? 1 : 0) };
    }
    // Seven different PRs: six interruptions (the day's cap), the seventh on the list.
    expect(channels).toEqual(['phasic', 'phasic', 'phasic', 'phasic', 'phasic', 'phasic', 'tonic']);
    const fresh: NoticeState = { habituation: {}, day: '2026-09-28', spentToday: 0, phasicToday: 0 };
    expect(decide(DEFAULT_GATE_POLICY, fresh, cands[0] as unknown as NoticeCandidate, at(30), '2026-09-28', 1).channel).toBe('deferred');
  });
});


describe('live and backtest agree by construction (U4-F14)', () => {
  it('over one mixed day, the fold and the backtest hold the same flags and say the same things', () => {
    // A made-up day: ticks while awake, idle, a sleep, a meeting, a call, Focus, windows and input noise.
    const day: SanitizedEvent[] = [];
    const push = (type: string, payload: Record<string, unknown>, min: number) => day.push(ev(type, payload, min));
    for (let m = 0; m < 600; m++) if (m < 200 || m > 320) push('clock:tick', {}, m);
    for (let m = 0; m < 600; m += 7) push('input:activity', { keyDownCount: m % 3 }, m + 0.5);
    for (let m = 0; m < 600; m += 13) push('window:changed', { processName: m % 2 ? 'Chat' : 'Code' }, m + 0.2);
    push('idle:start', {}, 90);
    push('idle:end', {}, 130);
    push('system:sleep-wake', { kind: 'sleep' }, 200);
    push('system:sleep-wake', { kind: 'wake' }, 320);
    push('calendar:active', { event: { eventId: 'm', isAllDay: false, startDate: at(400), endDate: at(460) } }, 400);
    push('media:state', { audioInput: true, camera: false }, 410);
    push('media:state', { audioInput: false, camera: false }, 450);
    push('focus-mode:changed', { state: 'do-not-disturb' }, 500);
    day.sort((a, b) => a.ts.localeCompare(b.ts));
    const checked = validateWatchRule({ title: 'Chat held', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chat' }] }, count: { atLeast: 2, withinMin: 30 }, while: { meeting: false, away: false }, say: '{count} chats', cooldownMin: 20 });
    if (!('rule' in checked)) throw new Error(checked.error);
    const live = run([ev('rule:adopted', { rule: checked.rule }, -1), ...day]);
    const types = new Set(backtestTypes(checked.rule));
    const replay = day.filter((e) => types.has(e.type));
    let flags = emptyWatchFlags();
    for (const e of replay) flags = stepWatchFlags(flags, e);
    expect(live.state.watch?.flags).toEqual(flags);
    const back = backtestWatch(checked.rule, replay, { daytime: () => true, timeZone: 'UTC' });
    expect(live.cands.map((c) => c.observation)).toEqual(back.fires.map((f) => f.text));
    expect(back.fires.length).toBeGreaterThan(2);
  });
});

describe('a rule\'s life: pause, versions, verdicts and the review (U4-F21 F22 F24 F25)', () => {
  const ci = { title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', cooldownMin: 1 };
  const red = (n: number, min: number) => ev('git:pr-status', { number: n, checkState: 'failure' }, min);
  const green = (n: number, min: number) => ev('git:pr-status', { number: n, checkState: 'success' }, min);
  const emitted = (events: SanitizedEvent[], state?: KernelState) => {
    let s = state ?? createInitialState('d');
    const out: { type: string; payload: Record<string, unknown> }[] = [];
    for (const e of events) {
      const r = watchRules(s, e);
      s = r.state;
      for (const x of r.effects as { type: string; event?: SanitizedEvent }[]) if (x.type === 'EmitEvent') out.push({ type: x.event!.type, payload: x.event!.payload as Record<string, unknown> });
    }
    return { state: s, out };
  };

  it('a paused rule emits nothing and keeps its runtime; resumed, it starts fresh', () => {
    const { state, out } = emitted([ev('rule:adopted', { rule: ci }, 0), red(1, 1), ev('rule:paused', { id: 'ci-failed' }, 2), green(1, 3), red(1, 4)]);
    expect(out.filter((o) => o.type === 'notice:candidate')).toHaveLength(1);
    expect(state.watch?.paused).toEqual(['ci-failed']);
    const frozen = state.watch?.runtime['ci-failed'];
    const later = emitted([red(2, 5)], state);
    expect(later.state.watch?.runtime['ci-failed']).toBe(frozen);
    const resumed = emitted([ev('rule:resumed', { id: 'ci-failed' }, 6), red(1, 7)], later.state);
    expect(resumed.out.map((o) => o.payload.observation)).toEqual(['CI failed on #1']);
  });

  it('the same id again is its next version, with a fresh record and the backtest it was adopted on', () => {
    const { state } = emitted([ev('rule:adopted', { rule: ci, predicted: { fired: 5, days: 30, heard: 3 } }, 0), red(1, 1), ev('rule:adopted', { rule: { ...ci, cooldownMin: 30 }, predicted: { fired: 2, days: 30 } }, 2)]);
    expect(state.watch?.stats?.['ci-failed']).toMatchObject({ version: 2, adoptedAt: at(2), predicted: { fired: 2, days: 30 }, fires: 0, recent: [] });
  });

  it('five wrong of five: the notice weighs less, the next day asks to drop it, and "Drop it" drops it', () => {
    const verdicts = Array.from({ length: 5 }, (_, i) => ev('feedback:verdict', { artifactKind: 'notice', artifactId: 'watch:ci-failed:0123456789', verdict: 'wrong' }, 10 + i));
    const { state, out } = emitted([ev('rule:adopted', { rule: ci }, 0), red(1, 1), ...verdicts, green(1, 20), red(1, 21), ev('day:boundary', { previousDate: '2026-09-28', newDate: '2026-09-29' }, 30)]);
    expect(state.watch?.stats?.['ci-failed']?.verdicts).toEqual({ useful: 0, wrong: 5, 'not-now': 0 });
    const cands = out.filter((o) => o.type === 'notice:candidate');
    expect(cands.map((c) => c.payload.precision)).toEqual([1, 1 / 7]);
    const ask = out.find((o) => o.type === 'ask:owner-opened');
    expect(ask?.payload).toMatchObject({ askId: 'owner-ask:rule-ci-failed', question: 'You marked 5 of 5 notices from "CI failed" wrong. Drop the rule?', choices: ['Drop it', 'Keep it'] });
    // Asked once: the next boundary does not ask again.
    expect(emitted([ev('day:boundary', {}, 40)], state).out).toEqual([]);
    const answered = emitted([ev('ask:owner-answered', { askId: 'owner-ask:rule-ci-failed', answer: 'Drop it' }, 50)], state);
    expect(answered.out).toEqual([{ type: 'rule:dropped', payload: { id: 'ci-failed', via: 'review' } }]);
  });

  it('drift: six fires in a week against a backtest of one a month asks, with both numbers', () => {
    const day = 24 * 60;
    const events = [ev('rule:adopted', { rule: ci, predicted: { fired: 1, days: 30 } }, 0)];
    for (let i = 0; i < 6; i++) events.push(red(100 + i, 7 * day + i * 60));
    events.push(ev('day:boundary', {}, 8 * day));
    const ask = emitted(events).out.find((o) => o.type === 'ask:owner-opened');
    expect(ask?.payload.question).toBe('"CI failed" fired 6 times this week; its backtest said about 0. Keep it as it is?');
    expect(ask?.payload.choices).toEqual(['Keep it', 'Pause it', 'Drop it']);
  });

  it('a rule adopted before records were kept starts one at the next day boundary', () => {
    const checked = validateWatchRule(ci);
    if (!('rule' in checked)) throw new Error(checked.error);
    const old: KernelState = { ...createInitialState('d'), watch: { rules: [checked.rule], runtime: {} } };
    const { state } = emitted([ev('day:boundary', {}, 0)], old);
    expect(state.watch?.stats?.['ci-failed']).toMatchObject({ version: 1, adoptedAt: at(0), fires: 0 });
  });
  it('a month without a fire asks whether to drop it', () => {
    const ask = emitted([ev('rule:adopted', { rule: ci }, 0), ev('day:boundary', {}, 31 * 24 * 60)]).out.find((o) => o.type === 'ask:owner-opened');
    expect(ask?.payload.question).toBe('"CI failed" has not fired in 30 days. Drop it?');
  });
});

describe('a rule that acts: internal verbs only (U4-F19)', () => {
  const pr = (n: number, min: number) => ev('git:pr-status', { number: n, checkState: 'failure' }, min);
  const types = (effects: unknown[]) => (effects as { event?: SanitizedEvent }[]).map((x) => x.event!.type);
  it('a fire can schedule a wake-up and a read-only job, and still speak', () => {
    const spec = { title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', do: [{ wakeup: { inMin: 60, reason: 'check #{number} again' } }, { job: { subject: 'Why #{number} is red', brief: 'Read the failing check.' } }] };
    const s = run([ev('rule:adopted', { rule: spec }, 0)]).state;
    const out = watchRules(s, pr(7, 1));
    expect(types(out.effects)).toEqual(['wakeup:scheduled', 'work:requested', 'notice:candidate']);
    const [wake, job] = (out.effects as unknown as { event: SanitizedEvent }[]).map((x) => x.event.payload);
    expect(wake).toMatchObject({ at: at(61), reason: 'check #7 again' });
    expect(job).toMatchObject({ subject: 'Why #7 is red', by: 'rule', rule: 'ci-failed' });
    expect(String(job!.brief)).toContain('From the watch rule "CI failed": CI failed on #7');
  });
  it('an ask is how it speaks: a question with choices, and no notice besides; nothing outward is accepted', () => {
    const spec = { title: 'PR waits', when: { type: 'git:pr-status' }, say: '#{number} waits', do: [{ ask: { question: '{said}. Book an hour to review it?', choices: ['Book it', 'Not now'] } }] };
    const out = watchRules(run([ev('rule:adopted', { rule: spec }, 0)]).state, pr(8, 1));
    expect(types(out.effects)).toEqual(['ask:owner-opened']);
    expect((out.effects as unknown as { event: SanitizedEvent }[])[0]!.event.payload).toMatchObject({ question: '#8 waits. Book an hour to review it?', choices: ['Book it', 'Not now'] });
    expect('error' in validateWatchRule({ ...spec, do: [{ calendar: { title: 'focus' } }] })).toBe(true);
    expect('error' in validateWatchRule({ ...spec, do: [{ shell: { command: 'rm' } }] })).toBe(true);
  });
  it('the backtest lists what it would have done', () => {
    const checked = validateWatchRule({ title: 'CI failed', when: { type: 'git:pr-status' }, say: '#{number}', do: [{ job: { subject: 'Look at #{number}', brief: 'b' } }] });
    if (!('rule' in checked)) throw new Error(checked.error);
    expect(backtestWatch(checked.rule, [pr(9, 0)], { daytime: () => true }).fires[0]?.wouldDo).toEqual(['job: Look at #9']);
  });
});

describe('a plain rule needs no model to be said (UC4 §10)', () => {
  it('the gate passes plain to the push, and a plain list row schedules no model call', () => {
    const spec = { title: 'CI failed', when: { type: 'git:pr-status' }, say: 'CI failed on #{number}', plain: true };
    const cand = (run([ev('rule:adopted', { rule: spec }, 0), ev('git:pr-status', { number: 1 }, 1)]).cands[0] as unknown) as NoticeCandidate;
    expect((cand as unknown as { plain?: boolean }).plain).toBe(true);
    let s = createInitialState('d');
    const gated = noticeGate(s, ev('notice:candidate', cand as unknown as Record<string, unknown>, 2));
    const phasic = gated.effects.find((e) => e.type === 'Notify') as { payload: { plain?: boolean } } | undefined;
    expect(phasic?.payload.plain).toBe(true);
    // Six interruptions already today: the next one is judged for the list.
    const full = Array.from({ length: 6 }, () => gated.state.notices.recentPhasic[0]!);
    s = { ...gated.state, notices: { ...gated.state.notices, recentPhasic: full } };
    const listed = noticeGate(s, ev('notice:candidate', { ...(cand as unknown as Record<string, unknown>), key: 'watch:ci-failed:x' }, 3));
    expect(listed.effects.find((e) => e.type === 'Notify')).toMatchObject({ channel: 'tonic-notice', payload: { plain: true } });
    expect(listed.effects.map((e) => e.type)).not.toContain('ScheduleLLM');
  });
});
