import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GATE_POLICY, type GatePolicy, type NoticeState, applyDelivery, calibratedPolicy, decide, habituatedGain, interruptionCostOf, noticeGate } from './notice-gate.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const POLICY = DEFAULT_GATE_POLICY;
const EMPTY: NoticeState = { habituation: {}, day: '', spentToday: 0 };

function candidate(over: Partial<NoticeCandidate> = {}): NoticeCandidate {
  return {
    shape: 'omission',
    kind: 'absent:break',
    key: 'absent:break|any',
    surprise: 3,
    precision: 0.9,
    valueHalfLifeMs: null,
    observation: '6 hours without a break',
    evidence: ['usual gap 90 min', 'n=20'],
    concerns: [],
    ...over,
  };
}

function candidateEvent(c: NoticeCandidate, ts = '2026-03-10T14:00:00.000Z'): SanitizedEvent {
  return { id: 'c1', type: 'notice:candidate', ts, payload: { timestamp: ts, ...c }, sanitized: true };
}


/** W5 step 10: the kinds under test have earned interrupting alone (the phasic path is what these tests exercise). */
const actAlone = (s: KernelState, kinds: string[]): KernelState => ({ ...s, autonomy: { ...s.autonomy, levels: { ...s.autonomy.levels, ...Object.fromEntries(kinds.map((k) => [`notice:${k}`, { level: 'act' as const, earned: true, since: '2026-01-01T00:00:00.000Z' }])) } } });

function utcState(): KernelState {
  const base = createInitialState('d1');
  return actAlone({ ...base, config: { ...base.config, timezone: 'UTC' } }, ['absent:break', 'agent-waiting', 'day-runs-long', 'owner-question', 'work-shelved', 'nope']);
}

describe('habituatedGain', () => {
  it('is 1 for a key never delivered', () => {
    expect(habituatedGain(undefined, Date.now(), POLICY)).toBe(1);
  });

  it('drops multiplicatively per delivery', () => {
    let notices = EMPTY;
    const gains: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ts = new Date(Date.parse('2026-03-10T09:00:00.000Z') + i * 60_000).toISOString();
      gains.push(habituatedGain(notices.habituation['k'], Date.parse(ts), POLICY));
      notices = applyDelivery(notices, candidate({ key: 'k' }), ts, '2026-03-10', 'tonic', POLICY);
    }

    // 1 -> 0.4 -> 0.16 -> 0.064 -> 0.026, minute-apart so recovery is negligible.
    // This is the mechanical answer to a surface that printed "Fifteenth spike this
    // week": by the fourth repetition there is nothing left to clear a threshold with.
    expect(gains[0]).toBe(1);
    expect(gains[1]).toBeCloseTo(0.4, 2);
    expect(gains[3]).toBeCloseTo(0.064, 2);
    expect(gains[4]).toBeLessThan(0.03);
    expect(gains[0]! > gains[1]! && gains[1]! > gains[2]! && gains[2]! > gains[3]!).toBe(true);
  });

  it('recovers to full volume after ONE delivery, so a routine that breaks again months later is news again', () => {
    const at = '2026-03-10T09:00:00.000Z';
    const entry = applyDelivery(EMPTY, candidate({ key: 'k' }), at, '2026-03-10', 'tonic', POLICY).habituation['k'];

    expect(habituatedGain(entry, Date.parse(at), POLICY)).toBeCloseTo(0.4, 5);
    expect(habituatedGain(entry, Date.parse(at) + POLICY.recoveryHalfLifeMs, POLICY)).toBeCloseTo(0.7, 2);
    expect(habituatedGain(entry, Date.parse(at) + 60 * DAY, POLICY)).toBeGreaterThan(0.99);
  });

  it('does not recover to full volume for something already said several times', () => {
    // The ceiling itself habituates: said four times, it can never again be more than
    // a quarter as loud without new information. This is what bounds a persistent
    // problem to a few mentions instead of an endless slow drip.
    let notices = EMPTY;
    for (let i = 0; i < 4; i += 1) {
      notices = applyDelivery(notices, candidate({ key: 'k' }), `2026-03-10T0${i + 1}:00:00.000Z`, '2026-03-10', 'tonic', POLICY);
    }
    const afterAges = habituatedGain(notices.habituation['k'], Date.parse('2027-01-01T00:00:00.000Z'), POLICY);
    expect(afterAges).toBeCloseTo(0.25, 2);
  });

  it('never exceeds 1 no matter how long it recovers', () => {
    const delivered = applyDelivery(EMPTY, candidate({ key: 'k' }), '2026-03-10T09:00:00.000Z', '2026-03-10', 'tonic', POLICY);
    expect(habituatedGain(delivered.habituation['k'], Date.parse('2030-01-01T00:00:00.000Z'), POLICY)).toBeLessThanOrEqual(1);
  });
});

describe('decide', () => {
  it('admits a well-founded, non-decaying candidate to the tonic list', () => {
    const d = decide(POLICY, EMPTY, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10');
    expect(d.channel).toBe('tonic');
    expect(d.weight).toBeCloseTo(2.7, 5);
  });

  it('suppresses a candidate whose precision is thin, however surprising it is', () => {
    // The deleted insights in one assertion: a big number times almost no confidence
    // is not worth saying.
    const d = decide(POLICY, EMPTY, candidate({ surprise: 6, precision: 0.05 }), '2026-03-10T14:00:00.000Z', '2026-03-10');
    expect(d.channel).toBe('suppressed');
    expect(d.reason).toBe('below-threshold');
  });

  it('routes by decay of value, not by weight', () => {
    const urgent = candidate({ valueHalfLifeMs: 45 * 60_000, surprise: 4, precision: 0.9 });
    expect(decide(POLICY, EMPTY, urgent, '2026-03-10T14:00:00.000Z', '2026-03-10').channel).toBe('phasic');

    const heavyButKeeps = candidate({ valueHalfLifeMs: null, surprise: 40, precision: 1 });
    // Enormous weight, but it reads the same tomorrow, so it must never interrupt.
    expect(decide(POLICY, EMPTY, heavyButKeeps, '2026-03-10T14:00:00.000Z', '2026-03-10').channel).toBe('tonic');
  });

  it('holds an urgent candidate to a much higher bar than a tonic one', () => {
    const middling = candidate({ valueHalfLifeMs: 45 * 60_000, surprise: 1.2, precision: 0.8 });
    const d = decide(POLICY, EMPTY, middling, '2026-03-10T14:00:00.000Z', '2026-03-10');
    // Would have cleared the tonic threshold comfortably; a false interruption costs
    // more than a weak row in a list.
    expect(d.weight).toBeGreaterThan(POLICY.tonicThreshold);
    expect(d.channel).toBe('suppressed');
  });

  it('spends the daily budget, and urgency ignores it', () => {
    const spent: NoticeState = { habituation: {}, day: '2026-03-10', spentToday: POLICY.dailyBudget };

    // Ordinary weight: the budget is the whole point, and it holds.
    const ordinary = candidate({ surprise: 1 }); // weight 0.9 — clears tonic, under the exemption.
    expect(decide(POLICY, spent, ordinary, '2026-03-10T14:00:00.000Z', '2026-03-10').reason).toBe('budget-spent');
    // The whole point of the second channel: "if I need be notified it should be able to".
    expect(decide(POLICY, spent, candidate({ valueHalfLifeMs: 45 * 60_000, surprise: 4 }), '2026-03-10T14:00:00.000Z', '2026-03-10').channel).toBe('phasic');
  });

  it('lets a candidate over `budgetExemptAbove` past a spent budget, still on the tonic channel', () => {
    const spent: NoticeState = { habituation: {}, day: '2026-03-10', spentToday: POLICY.dailyBudget };

    // The production case this exists for: the budget is spent first-come-first-served,
    // so without the exemption the strongest thing all day loses to whatever landed
    // first. Weight 2.7, over the 1.6 exemption.
    const strong = decide(POLICY, spent, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10');
    expect(strong.weight).toBeGreaterThan(POLICY.budgetExemptAbove ?? Infinity);
    expect(strong.reason).toBe('admitted');
    // Exempt from the BUDGET, not promoted to an interruption — it has no urgency.
    expect(strong.channel).toBe('tonic');

    // And the exemption is opt-in: null restores the pre-2026-08-16 behaviour.
    const off = decide({ ...POLICY, budgetExemptAbove: null }, spent, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10');
    expect(off.reason).toBe('budget-spent');
  });

  it('resets the budget on a new local day without needing a boundary event', () => {
    const spent: NoticeState = { habituation: {}, day: '2026-03-10', spentToday: 5 };
    expect(decide(POLICY, spent, candidate(), '2026-03-11T09:00:00.000Z', '2026-03-11').channel).toBe('tonic');
  });

  it('names habituation as the reason once a key has been worn down', () => {
    let notices = EMPTY;
    // Same day, hours apart, so recovery has no room to intervene — this isolates the
    // decay from the recovery.
    for (let i = 0; i < 3; i += 1) {
      notices = applyDelivery(notices, candidate(), `2026-03-10T0${i + 1}:00:00.000Z`, '2026-03-10', 'tonic', POLICY);
    }
    const d = decide(POLICY, notices, candidate(), '2026-03-10T09:00:00.000Z', '2026-03-10');
    expect(d.channel).toBe('suppressed');
    expect(d.reason).toBe('habituated');
  });

  it('lifts a candidate that touches an open commitment', () => {
    const plain = decide(POLICY, EMPTY, candidate({ surprise: 0.5, precision: 0.9 }), '2026-03-10T14:00:00.000Z', '2026-03-10');
    const concerning = decide(POLICY, EMPTY, candidate({ surprise: 0.5, precision: 0.9, concerns: ['commitment:x'] }), '2026-03-10T14:00:00.000Z', '2026-03-10');

    expect(plain.channel).toBe('suppressed');
    expect(concerning.channel).toBe('tonic');
  });

  it('is pure — the same inputs give the same answer', () => {
    const args = [POLICY, EMPTY, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10'] as const;
    expect(decide(...args)).toEqual(decide(...args));
  });

  it('honours a policy with habituation disabled, which is how the control behaves', () => {
    const control: GatePolicy = { ...POLICY, habituationStep: 1, dailyBudget: 99 };
    let notices = EMPTY;
    let admitted = 0;
    for (let i = 0; i < 15; i += 1) {
      const ts = new Date(Date.parse('2026-03-10T09:00:00.000Z') + i * HOUR).toISOString();
      const d = decide(control, notices, candidate(), ts, '2026-03-10');
      if (d.channel !== 'suppressed') {
        admitted += 1;
        notices = applyDelivery(notices, candidate(), ts, '2026-03-10', d.channel as 'tonic' | 'phasic', control);
      }
    }
    // Fifteen identical notices, which is precisely what the live surface produced.
    expect(admitted).toBe(15);
  });
});

describe('applyDelivery', () => {
  it('charges the budget for a tonic delivery but not a phasic one', () => {
    const tonic = applyDelivery(EMPTY, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10', 'tonic', POLICY);
    const phasic = applyDelivery(EMPTY, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10', 'phasic', POLICY);
    expect(tonic.spentToday).toBe(1);
    expect(phasic.spentToday).toBe(0);
  });

  it('habituates both channels — an interruption is still a thing already said', () => {
    const phasic = applyDelivery(EMPTY, candidate(), '2026-03-10T14:00:00.000Z', '2026-03-10', 'phasic', POLICY);
    expect(phasic.habituation['absent:break|any']!.fires).toBe(1);
  });

  it('bounds the habituation map by evicting the oldest keys', () => {
    let notices = EMPTY;
    for (let i = 0; i < 260; i += 1) {
      const ts = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * HOUR).toISOString();
      notices = applyDelivery(notices, candidate({ key: `k${i}` }), ts, '2026-01-01', 'tonic', POLICY);
    }
    expect(Object.keys(notices.habituation)).toHaveLength(200);
    expect(notices.habituation['k0']).toBeUndefined();
    expect(notices.habituation['k259']).toBeDefined();
  });
});

describe('noticeGate rule', () => {
  it('says nothing at all when the owner set autonomy off, and records why', () => {
    const state = { ...utcState(), settings: { ...utcState().settings, autonomy: 'off' as const } };
    const { state: next, effects } = noticeGate(state, candidateEvent(candidate()));
    // No Notify, no ScheduleLLM — one record of the refusal, so the Unsaid
    // surface can say why the owner never heard of it.
    expect(effects).toHaveLength(1);
    const decision = effects[0] as unknown as { type: string; channel: string; reason: string };
    expect([decision.type, decision.channel, decision.reason]).toEqual(['RecordGateDecision', 'suppressed', 'owner-silent']);
    expect(next).toBe(state); // nothing spent, nothing habituated
  });

  it('holds back a group the owner turned off, records why, and never quiets an owner question', () => {
    const state = { ...utcState(), settings: { ...utcState().settings, quiet: ['agents'] } };
    const held = noticeGate(state, candidateEvent(candidate({ kind: 'agent-waiting' })));
    expect(held.effects.map((e) => (e as unknown as { reason: string }).reason)).toEqual(['owner-quiet']);
    expect(held.state).toBe(state);
    const asked = noticeGate(state, candidateEvent(candidate({ kind: 'owner-question' })));
    expect(asked.effects.some((e) => (e as unknown as { reason?: string }).reason === 'owner-quiet')).toBe(false);
  });

  it('moves the same bar the policy judges by when the owner asks for quieter', () => {
    const verdict = (state: KernelState) =>
      (noticeGate(state, candidateEvent(candidate({ surprise: 2, precision: 0.75 }))).effects.find((e) => (e as unknown as { type: string }).type === 'RecordGateDecision') as unknown as { channel: string }).channel;
    // Worth 1.5 — over the policy's own 0.55 bar, under the 2.2 that +2 makes of it.
    expect(verdict(utcState())).toBe('tonic');
    expect(verdict({ ...utcState(), settings: { ...utcState().settings, noticeBias: 2 } })).toBe('suppressed');
  });

  it('ignores everything but notice:candidate', () => {
    const state = utcState();
    const { state: next, effects } = noticeGate(state, { id: 'x', type: 'clock:tick', ts: '2026-03-10T14:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('drops a malformed payload rather than folding it', () => {
    const state = utcState();
    const { effects } = noticeGate(state, { id: 'x', type: 'notice:candidate', ts: '2026-03-10T14:00:00.000Z', payload: { kind: 'nope' }, sanitized: true });
    expect(effects).toEqual([]);
  });

  it('schedules the companion LLM call for a tonic admission, and announces it on the delivery channel', () => {
    const { state: next, effects } = noticeGate(utcState(), candidateEvent(candidate()));
    // Tonic Notify (immediate ambient delivery) + ScheduleLLM (the polished
    // insight, minutes later) + the durable decision record.
    expect(effects.map((e) => e.type)).toEqual(['Notify', 'ScheduleLLM', 'RecordGateDecision']);
    const notify = effects[0] as unknown as { channel: string; payload: { noticeKey: string; observation: string } };
    expect(notify.channel).toBe('tonic-notice');
    expect(notify.payload.noticeKey).toBe('absent:break|any');
    expect(notify.payload.observation).toContain('6 hours without a break');
    const effect = effects[1] as unknown as { type: string; purpose: string; messages: { role: string; content: string }[] };
    expect(effect.type).toBe('ScheduleLLM');
    expect(effect.purpose).toBe('companion');
    // The observation must reach the model verbatim, since the prompt forbids adding
    // anything to it.
    expect(effect.messages[1]!.content).toContain('6 hours without a break');
    expect(next.notices.spentToday).toBe(1);
  });

  it('forbids the model from naming a state no sensor observes', () => {
    const { effects } = noticeGate(utcState(), candidateEvent(candidate()));
    const system = (effects[1] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(system).toContain('never add a cause, a feeling, or a recommendation');
    expect(system).toContain('burned out');
  });

  it('emits Notify and records the phasic queue for an interrupting admission', () => {
    const urgent = candidate({ kind: 'day-runs-long', key: 'day-runs-long:2026-03-10', valueHalfLifeMs: 90 * 60_000, surprise: 4, precision: 0.9 });
    const { state: next, effects } = noticeGate(utcState(), candidateEvent(urgent));

    expect((effects[0] as unknown as { type: string; channel: string }).type).toBe('Notify');
    expect((effects[0] as unknown as { channel: string }).channel).toBe('phasic-notice');
    // The delivery channel needs the gate key to route a later `not-now` verdict.
    expect((effects[0] as unknown as { payload: { noticeKey: string } }).payload.noticeKey).toBe('day-runs-long:2026-03-10');
    expect(next.notices.recentPhasic).toHaveLength(1);
    expect(next.notices.recentPhasic[0]!.kind).toBe('day-runs-long');
    // Urgency does not spend the tonic budget.
    expect(next.notices.spentToday).toBe(0);
  });

  /** N2 — the interrupting channel had a threshold and a cost, and no count. */
  it('past `phasicDailyCap` interruptions today, an urgent candidate lands on the list instead', () => {
    const urgent = (i: number) => candidate({ kind: 'day-runs-long', key: `day-runs-long:${i}`, valueHalfLifeMs: 90 * 60_000, surprise: 4, precision: 0.9 });
    let state = utcState();
    const channels: string[] = [];
    for (let i = 0; i <= POLICY.phasicDailyCap; i += 1) {
      const out = noticeGate(state, { ...candidateEvent(urgent(i), `2026-03-10T1${i}:00:00.000Z`), id: `c${i}` });
      state = out.state;
      channels.push((out.effects[0] as unknown as { channel: string }).channel);
    }
    expect(channels.filter((c) => c === 'phasic-notice')).toHaveLength(POLICY.phasicDailyCap);
    expect(channels.at(-1)).toBe('tonic-notice');
    // A new day, a fresh allowance — the queue is not cleared, it is counted by day.
    const tomorrow = noticeGate(state, { ...candidateEvent(urgent(99), '2026-03-11T09:00:00.000Z'), id: 'c99' });
    expect((tomorrow.effects[0] as unknown as { channel: string }).channel).toBe('phasic-notice');
  });

  // W2 step 7: an interruption the plugin could not deliver did not spend the owner's attention.
  it('a dropped notice does not spend the phasic cap, and Unsaid gets an undelivered row', () => {
    const urgent = (i: number) => candidate({ kind: 'day-runs-long', key: `day-runs-long:${i}`, valueHalfLifeMs: 90 * 60_000, surprise: 4, precision: 0.9 });
    let state = utcState();
    for (let i = 0; i < POLICY.phasicDailyCap; i += 1) state = noticeGate(state, { ...candidateEvent(urgent(i), `2026-03-10T1${i}:00:00.000Z`), id: `c${i}` }).state;
    const drop = noticeGate(state, { id: 'd1', type: 'notice:dropped', ts: '2026-03-10T16:30:00.000Z', payload: { noticeKey: 'day-runs-long:2', sessionId: null, reason: 'companion-disposed', kind: 'day-runs-long' }, sanitized: true });
    expect(drop.effects).toEqual([expect.objectContaining({ type: 'RecordGateDecision', noticeKey: 'day-runs-long:2', channel: 'suppressed', reason: 'undelivered:companion-disposed' })]);
    expect(drop.state.notices.recentPhasic.find((p) => p.noticeKey === 'day-runs-long:2')?.undelivered).toBe('companion-disposed');
    const next = noticeGate(drop.state, { ...candidateEvent(urgent(7), '2026-03-10T17:00:00.000Z'), id: 'c7' });
    expect((next.effects[0] as unknown as { channel: string }).channel).toBe('phasic-notice');
    const capped = noticeGate(state, { ...candidateEvent(urgent(7), '2026-03-10T17:00:00.000Z'), id: 'c7' });
    expect((capped.effects[0] as unknown as { channel: string }).channel).toBe('tonic-notice');
  });

  it('puts the delivery acts and the addressed chat on the Notify', () => {
    const phasic = noticeGate(utcState(), candidateEvent(candidate({ kind: 'day-runs-long', key: 'k1', valueHalfLifeMs: 90 * 60_000, surprise: 4, precision: 0.9 })));
    expect(phasic.effects[0]).toMatchObject({ type: 'Notify', channel: 'phasic-notice', payload: { sessionId: null, acts: ['inject', 'turn', 'push', 'banner'] } });
    const line = noticeGate(utcState(), candidateEvent({ ...candidate({ kind: 'followup:unpushed', key: 'followup:unpushed:abc', surprise: 2, precision: 1, valueHalfLifeMs: 4 * HOUR, sessionId: 'session-7f' }), plain: true } as NoticeCandidate));
    expect(line.effects.map((e) => e.type)).toEqual(['Notify', 'RecordGateDecision']);
    expect(line.effects[0]).toMatchObject({ channel: 'tonic-notice', payload: { sessionId: 'session-7f', acts: ['line'] } });
  });

  it('leaves no trace in the gate memory when it suppresses — but records the verdict durably', () => {
    // A producer may legitimately re-offer a candidate before it ever clears the bar.
    // Habituating on presentation would kill exactly those before they were said once.
    const state = utcState();
    const weak = candidate({ surprise: 0.2, precision: 0.2 });
    const { state: next, effects } = noticeGate(state, candidateEvent(weak));
    // The gate's memory is untouched: no habituation, no budget. The one thing
    // counted is W5's exploration share for the kind (a count, not a delivery);
    // the decision itself is persisted as an effect — the gate-decision record's trade.
    expect(next.notices.habituation).toBe(state.notices.habituation);
    expect(next.notices.spentToday).toBe(state.notices.spentToday);
    expect(next.notices.explore).toEqual({ 'absent:break': 1 });
    expect(effects).toHaveLength(1);
    const record = effects[0] as unknown as { type: string; channel: string; reason: string; surprise: number; habituation: number };
    expect(record.type).toBe('RecordGateDecision');
    expect(record.channel).toBe('suppressed');
    expect(record.reason).toBe('below-threshold');
    expect(record.surprise).toBe(0.2);
    expect(record.habituation).toBe(1);
  });

  it('records the bars the dial left, not the ones the policy ships', () => {
    // K0.2. `noticeGate` scales BOTH thresholds by `2 ** noticeBias` before it
    // weighs anything, and nothing recorded that — so the Unsaid card drew
    // today's line across the whole record and 40 of its 171 rows sat on the
    // wrong side of a bar they were never measured against. The bar is part of
    // the decision, so the RULE writes it; a surface deriving it a second time
    // is a second policy that agrees on the day it is written.
    const bars = (bias: number): [number, number] => {
      const base = utcState();
      const state = { ...base, settings: { ...base.settings, noticeBias: bias } };
      const row = noticeGate(state, candidateEvent(candidate({ surprise: 0.2, precision: 0.2 }))).effects.find((e) => e.type === 'RecordGateDecision') as
        | { tonicBar: number; phasicBar: number }
        | undefined;
      if (row === undefined) throw new Error('the gate recorded no decision');
      return [row.tonicBar, row.phasicBar];
    };
    expect(bars(0)).toEqual([DEFAULT_GATE_POLICY.tonicThreshold, DEFAULT_GATE_POLICY.phasicThreshold]);
    // One notch of the owner's dial is a doubling, wherever the bar happens to
    // be — the same expression DESIGN.md's log axis is drawn in.
    expect(bars(-1)).toEqual([DEFAULT_GATE_POLICY.tonicThreshold / 2, DEFAULT_GATE_POLICY.phasicThreshold / 2]);
    expect(bars(2)).toEqual([DEFAULT_GATE_POLICY.tonicThreshold * 4, DEFAULT_GATE_POLICY.phasicThreshold * 4]);
  });

  it('mentions a persistent problem a few times, not every day', () => {
    let state = utcState();
    let scheduled = 0;
    for (let day = 10; day < 20; day += 1) {
      const ts = `2026-03-${day}T14:00:00.000Z`;
      const result = noticeGate(state, candidateEvent(candidate(), ts));
      state = result.state;
      // Count DELIVERIES, not effects: every offer now also emits a durable
      // RecordGateDecision, said or not.
      scheduled += result.effects.filter((e) => e.type === 'ScheduleLLM').length;
    }

    // Ten offers of the same strong absence over ten days. Saying it once and never
    // again would be wrong — the problem is ongoing — and saying it ten times is the
    // behaviour being replaced. Three is the honest target, and the count must fall
    // well short of the offers.
    expect(scheduled).toBeGreaterThanOrEqual(1);
    expect(scheduled).toBeLessThanOrEqual(3);
  });

  it('says far less than the same pipeline with habituation switched off', () => {
    // The control comparison, on the real rule rather than on `decide` alone.
    const offers = Array.from({ length: 10 }, (_, i) => `2026-03-${10 + i}T14:00:00.000Z`);

    let gated = utcState();
    let gatedCount = 0;
    for (const ts of offers) {
      const result = noticeGate(gated, candidateEvent(candidate(), ts));
      gated = result.state;
      // One `Notify` per admission — `phasic-notice` or `tonic-notice` — which is
      // the honest unit against the control's count of admissions. Counting raw
      // effects instead would score a tonic admission twice (its Notify AND the
      // ScheduleLLM that polishes it hours later) and count the `RecordGateDecision`
      // audit row as speech, making a quieter gate look louder the better its
      // bookkeeping got.
      gatedCount += result.effects.filter((e) => e.type === 'Notify').length;
    }

    let ungated: NoticeState = EMPTY;
    const control: GatePolicy = { ...POLICY, habituationStep: 1, dailyBudget: 99 };
    let ungatedCount = 0;
    for (const ts of offers) {
      const d = decide(control, ungated, candidate(), ts, ts.slice(0, 10));
      if (d.channel !== 'suppressed') {
        ungatedCount += 1;
        ungated = applyDelivery(ungated, candidate(), ts, ts.slice(0, 10), d.channel as 'tonic' | 'phasic', control);
      }
    }

    expect(ungatedCount).toBe(10);
    expect(gatedCount).toBeLessThan(ungatedCount / 2);
  });
});

describe('noticeGate · an answered ask leaves the ring', () => {
  it('drops a deferred owner-question when its ask is answered, and leaves the rest', () => {
    const base = createInitialState('d1');
    const mk = (key: string, askId?: string) => ({
      candidate: { key, kind: askId ? 'owner-question' : 'return-from-break', surprise: 2, precision: 1, valueHalfLifeMs: 7_200_000, observation: 'q', evidence: [], concerns: [], timestamp: '2026-09-07T10:00:00.000Z', shape: 'self-report', ...(askId ? { askId } : {}) },
      since: '2026-09-07T10:00:00.000Z',
      reconsidered: 0,
    });
    const state = { ...base, notices: { ...base.notices, deferred: [mk('owner-ask:meeting-1', 'owner-ask:meeting-1'), mk('return-from-break:2026-09-07')] } } as never as typeof base;
    const { state: next } = noticeGate(state, { id: 'e1', type: 'ask:owner-answered', ts: '2026-09-07T10:05:00.000Z', payload: { askId: 'owner-ask:meeting-1', answer: 'fine' } } as never);
    expect(next.notices.deferred.map((d) => d.candidate.key)).toEqual(['return-from-break:2026-09-07']);
  });
});

describe('J2.1 / J3.1 — the owner in the interruption cost', () => {
  it('the owner-state filter prices nothing until config.experiments.ownerStateInGateCost is on', () => {
    const base = createInitialState('d1');
    // A quiet work moment (no input yet): the arithmetic prices it at the quiet floor.
    const quiet = { ...base, moment: { id: 'm', sessionId: 's', startTime: '2026-09-22T10:00:00.000Z', processName: 'Code', projectId: null, rollup: { processName: 'Code', windowTitles: ['x'], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } } as never };
    const sure = { ...quiet, owner: { ...quiet.owner, focus: { alpha: 99, beta: 1 } } };
    const off = interruptionCostOf(sure);
    const on = interruptionCostOf({ ...sure, config: { ...sure.config, experiments: { ...sure.config.experiments, ownerStateInGateCost: true } } });
    expect(off).toBeLessThan(0.5);
    expect(on).toBeCloseTo(0.99, 2);
  });
});

describe('noticeGate · away from the Mac, the list waits for the return', () => {
  const T0 = '2026-03-10T08:00:00.000Z';
  const ev = (type: string, payload: Record<string, unknown>, ts: string, id = `${type}-${ts}`): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
  const plus = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
  const fold = (state: KernelState, events: SanitizedEvent[]) => {
    const effects: { type: string; channel?: string; reason?: string }[] = [];
    for (const e of events) {
      const out = noticeGate(state, e);
      state = out.state;
      effects.push(...(out.effects as { type: string; channel?: string; reason?: string }[]));
    }
    return { state, effects };
  };
  // A four-hour half-life, like a shelved job: tonic, and decayed by morning.
  const shelved = candidate({ kind: 'work-shelved', key: 'work-shelved:j1', valueHalfLifeMs: 4 * HOUR });

  it('an hour into an absence a tonic notice is held, not spent; before the hour it lands as ever', () => {
    const early = fold(utcState(), [ev('idle:start', {}, T0), candidateEvent(shelved, plus(30))]);
    expect(early.effects.some((e) => e.type === 'Notify' && e.channel === 'tonic-notice')).toBe(true);

    const late = fold(utcState(), [ev('idle:start', {}, T0), candidateEvent(shelved, plus(70))]);
    expect(late.effects.map((e) => e.type)).toEqual(['RecordGateDecision']);
    expect(late.effects[0]).toMatchObject({ channel: 'deferred', reason: 'owner-away' });
    expect(late.state.notices.away?.held.map((h) => h.candidate.key)).toEqual(['work-shelved:j1']);
    expect(late.state.notices.spentToday).toBe(0);
  });

  it('the first real input weighs it again and delivers it, however long the absence ate of its half-life', () => {
    const { state, effects } = fold(utcState(), [
      ev('system:sleep-wake', { kind: 'sleep' }, T0),
      candidateEvent(shelved, plus(70)),
      ev('system:sleep-wake', { kind: 'wake' }, plus(600)),
      ev('input:activity', { keyDownCount: 0, mouseMoveCount: 0 }, plus(601)),
      ev('input:activity', { keyDownCount: 3 }, plus(602)),
    ]);
    const notify = effects.filter((e) => e.type === 'Notify');
    expect(notify).toHaveLength(1);
    expect(notify[0]).toMatchObject({ channel: 'tonic-notice' });
    expect(state.notices.away).toEqual({ since: null, held: [] });
    expect(state.notices.spentToday).toBe(1);
    expect(state.notices.habituation['work-shelved:j1']?.at).toBe(plus(602));
  });

  it('an interruption is never held: it still goes out while the owner is away', () => {
    const urgent = candidate({ kind: 'wakeup', key: 'wakeup:x', surprise: 2, precision: 1, valueHalfLifeMs: 30 * 60_000 });
    const { effects } = fold(utcState(), [ev('idle:start', {}, T0), candidateEvent(urgent, plus(90))]);
    expect(effects.some((e) => e.type === 'Notify' && e.channel === 'phasic-notice')).toBe(true);
  });

  it('input while present costs nothing and allocates nothing', () => {
    const s = utcState();
    expect(noticeGate(s, ev('input:activity', { keyDownCount: 5 }, T0)).state).toBe(s);
  });
});

describe('noticeGate · a held notice that runs out of time says so', () => {
  it('records an expiry as suppressed / expired instead of vanishing', () => {
    const base = utcState();
    const held = candidate({ kind: 'agent-waiting', key: 'agent-waiting:s1', valueHalfLifeMs: 30 * 60_000 });
    const state = { ...base, notices: { ...base.notices, deferred: [{ candidate: held, since: '2026-03-10T09:00:00.000Z', reconsidered: 3 }] } };
    const out = noticeGate(state, { id: 't1', type: 'clock:tick', ts: '2026-03-10T09:45:00.000Z', payload: {}, sanitized: true });
    expect(out.state.notices.deferred).toEqual([]);
    expect(out.effects).toEqual([expect.objectContaining({ type: 'RecordGateDecision', noticeKey: 'agent-waiting:s1', channel: 'suppressed', reason: 'expired' })]);
  });
});

describe('W4 step 8: the gate reads each kind\'s measured precision', () => {
  const judged = (useful: number, wrong: number) => {
    const s = utcState();
    s.calibrated.params['notice.precision:absent:break'] = { n: useful + wrong, hits: useful, sum: useful, updatedAt: null };
    return s;
  };
  const weightOf = (s: KernelState) => noticeGate(s, candidateEvent(candidate())).effects.find((e) => e.type === 'RecordGateDecision') as { weight: number; precision: number };

  it('a kind nobody judged weighs as its producer says; a judged kind as it was judged', () => {
    expect(weightOf(utcState()).precision).toBeCloseTo(0.9, 10);
    // (0.9 · 10 + 2) / (10 + 20): judged mostly wrong, it weighs a third of its word.
    expect(weightOf(judged(2, 18)).precision).toBeCloseTo(11 / 30, 10);
    expect(weightOf(judged(2, 18)).weight).toBeCloseTo(3 * (11 / 30), 10);
  });

  it('an owner question keeps its slot over the cap only once its kind has earned it', () => {
    const s = utcState();
    expect(calibratedPolicy(s, DEFAULT_GATE_POLICY).reservedOverCap).toBe(0);
    s.calibrated.params['notice.precision:owner-question'] = { n: 30, hits: 27, sum: 27, updatedAt: null };
    expect(calibratedPolicy(s, DEFAULT_GATE_POLICY).reservedOverCap).toBe(1);
    // The cost weight stays the policy's until both cost bands hold TRUST_N questions.
    expect(calibratedPolicy(s, DEFAULT_GATE_POLICY).interruptionCostWeight).toBe(0.8);
    s.calibrated.params['gate.answered:high'] = { n: 20, hits: 4, sum: 4, updatedAt: null };
    s.calibrated.params['gate.answered:low'] = { n: 40, hits: 20, sum: 20, updatedAt: null };
    // At full cost the owner answers (0.4·10+4)/30 of what they answer at a low cost, (0.4·10+20)/50:
    // an interruption there is worth that share of a notice at the bar, so its cost is the rest.
    expect(calibratedPolicy(s, DEFAULT_GATE_POLICY).interruptionCostWeight).toBeCloseTo(1.6 * (1 - (8 / 30) / (24 / 50)), 10);
  });
});

describe('W5: exploration', () => {
  const weak = (i: number) => candidateEvent(candidate({ kind: 'commitment-fading', key: `commitment-fading:${i}`, surprise: 0.2 }), new Date(Date.parse('2026-03-10T09:00:00.000Z') + i * 60_000).toISOString());
  it('one in ten suppressed candidates of a thin kind is said in the list, marked as exploration', () => {
    let s = utcState();
    const decisions: { channel: string; reason: string }[] = [];
    const notifies: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const out = noticeGate(s, weak(i));
      s = out.state;
      for (const e of out.effects) {
        if (e.type === 'RecordGateDecision') decisions.push(e as unknown as { channel: string; reason: string });
        if (e.type === 'Notify') notifies.push(e.payload as Record<string, unknown>);
      }
    }
    expect(decisions.filter((d) => d.reason === 'exploration').map((d) => d.channel)).toEqual(['tonic', 'tonic']);
    expect(decisions.filter((d) => d.reason === 'below-threshold')).toHaveLength(18);
    expect(notifies.every((p) => p.exploration === true)).toBe(true);
    expect(s.notices.lastDelivered?.items[0]).toMatchObject({ exploration: true });
  });
  it('a kind judged 30 times is not explored', () => {
    let s = utcState();
    s.calibrated.params['notice.precision:commitment-fading'] = { n: 30, hits: 3, sum: 3, updatedAt: null };
    let explored = 0;
    for (let i = 0; i < 20; i++) {
      const out = noticeGate(s, weak(i));
      s = out.state;
      explored += out.effects.filter((e) => e.type === 'RecordGateDecision' && (e as unknown as { reason: string }).reason === 'exploration').length;
    }
    expect(explored).toBe(0);
  });
});
