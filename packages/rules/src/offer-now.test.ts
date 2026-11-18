// S6: one offer of help for a window held a few minutes, through the existing notice gate.
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { DEFAULT_DAILY_CAPS } from '@sundial/kernel/budgets.js';
import { reduce } from '@sundial/kernel/reduce.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { feedbackTrack } from './feedback-track.js';
import { RULE_MANIFEST } from './manifest.js';
import { noticeGate } from './notice-gate.js';
import { ASK_GAP_MS, HOLD_MS, offerKey, offerNow, parseOffer } from './offer-now.js';

const T0 = Date.parse('2026-03-10T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const win = (app: string, title: string, s: number) => ev('window:changed', { processName: app, windowTitle: title, windowId: `${app}-${title}` }, at(s));
const tick = (s: number) => ev('clock:tick', {}, at(s));
const base = (over: Partial<KernelState['config']['experiments']> = {}): KernelState => {
  const s = createInitialState('d');
  return { ...s, config: { ...s.config, timezone: 'UTC', experiments: { ...s.config.experiments, offerNow: true, ...over } } };
};
const asks = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'ScheduleLLM' }> => e.type === 'ScheduleLLM' && e.purpose === 'offer');

/** Folds `offerNow` alone over the events; returns the state and every offer question asked. */
function run(state: KernelState, events: SanitizedEvent[]) {
  const asked: Extract<Effect, { type: 'ScheduleLLM' }>[] = [];
  for (const e of events) {
    const out = offerNow(state, e);
    state = out.state;
    asked.push(...asks(out.effects));
  }
  return { state, asked };
}

const answer = (text: string, app: string, title: string, s: number) => ev('llm:result', { purpose: 'offer', text, momentId: null, metadata: { kind: 'offer-now', app, title, since: at(0) } }, at(s));
const OFFER = JSON.stringify({ offer: 'Want me to pull up the CI log for the failing build?', confidence: 0.8 });

describe('offerNow: when it asks', () => {
  it('asks once on a context held past the hold, with the sanitized context in the question', () => {
    const early = run(base(), [win('Xcode', 'Puzzlebox.swift', 0), tick(60)]);
    expect(early.asked).toHaveLength(0);
    const held = run(early.state, [tick(HOLD_MS / 1000), tick(HOLD_MS / 1000 + 60)]);
    expect(held.asked).toHaveLength(1);
    expect(held.asked[0]!.metadata).toMatchObject({ kind: 'offer-now', app: 'Xcode', title: 'Puzzlebox.swift' });
    expect(held.asked[0]!.messages.at(-1)!.content).toContain('Xcode, "Puzzlebox.swift"');
    expect(held.state.offerNow?.context?.asked).toBe(true);
  });

  it('does not ask on rapid switching, then asks once one window holds', () => {
    const events: SanitizedEvent[] = [];
    for (let s = 0; s < 300; s += 20) events.push(win(s % 40 === 0 ? 'Safari' : 'Code', `doc ${s}`, s), ...(s % 60 === 0 ? [tick(s + 10)] : []));
    const switching = run(base(), events);
    expect(switching.asked).toHaveLength(0);
    const settled = run(switching.state, [win('Code', 'notes.md', 300), tick(300 + HOLD_MS / 1000)]);
    expect(settled.asked).toHaveLength(1);
    // What came before goes with it, from the last ten minutes, at most six.
    expect(settled.asked[0]!.messages.at(-1)!.content).toContain('Before that:');
    expect(settled.state.offerNow!.recent.length).toBeLessThanOrEqual(6);
  });

  it('never asks for a private app or a private host, and never names one in a later question', () => {
    expect(run(base(), [win('Passwords', '[private]', 0), tick(600)]).asked).toHaveLength(0);
    const browser = { ...base(), browser: { ...base().browser, current: { app: 'Safari', host: 'mail.proton.me', path: '/inbox', title: null, since: at(0), updatedAt: at(1) } } };
    expect(run(browser, [win('Safari', 'Inbox', 0), tick(600)]).asked).toHaveLength(0);
    const later = run(base(), [win('Messages', '[private]', 0), win('Code', 'notes.md', 30), tick(30 + HOLD_MS / 1000)]);
    expect(later.asked).toHaveLength(1);
    expect(later.asked[0]!.messages.at(-1)!.content).not.toContain('private');
  });

  it('stops when its own budget is spent, and when the owner turned it off', () => {
    const spent = base();
    spent.budgets = { ...spent.budgets, byPurpose: { ...spent.budgets.byPurpose, offer: { callsToday: DEFAULT_DAILY_CAPS.offer } } };
    expect(run(spent, [win('Code', 'a.ts', 0), tick(600)]).asked).toHaveLength(0);
    expect(run({ ...base(), settings: { ...base().settings, autonomy: 'off' } }, [win('Code', 'a.ts', 0), tick(600)]).asked).toHaveLength(0);
    expect(run({ ...base(), settings: { ...base().settings, quiet: ['offers'] } }, [win('Code', 'a.ts', 0), tick(600)]).asked).toHaveLength(0);
    // The config switch: the manifest skips the rule when `experiments.offerNow` is false.
    let s = base({ offerNow: false });
    const effects: Effect[] = [];
    for (const e of [win('Code', 'a.ts', 0), tick(600)]) {
      const out = reduce(s, e, RULE_MANIFEST);
      s = out.state;
      effects.push(...out.effects.map((a) => a.effect));
    }
    expect(asks(effects)).toHaveLength(0);
  });

  it('a "not now" quiets that app (no call is spent there), another app still asks, and a "useful" restores it', () => {
    const first = run(base(), [win('Code', 'a.ts', 0), tick(HOLD_MS / 1000)]);
    expect(first.asked).toHaveLength(1);
    const verdict = (s: KernelState, verdict: string, sec: number) => feedbackTrack(s, ev('feedback:verdict', { artifactKind: 'notice', artifactId: offerKey('Code'), verdict }, at(sec))).state;
    const t = 3600;
    expect(run(first.state, [win('Code', 'b.ts', t), tick(t + HOLD_MS / 1000)]).asked).toHaveLength(1);
    const quiet = verdict(first.state, 'not-now', 200);
    expect(run(quiet, [win('Code', 'b.ts', t), tick(t + HOLD_MS / 1000)]).asked).toHaveLength(0);
    expect(run(quiet, [win('Figma', 'Board', t), tick(t + HOLD_MS / 1000)]).asked).toHaveLength(1);
    expect(run(verdict(quiet, 'useful', 300), [win('Code', 'b.ts', t), tick(t + HOLD_MS / 1000)]).asked).toHaveLength(1);
  });

  it('asks against the offers bar (config.offerBar), not the 1.6 every other notice keeps, and not once the day\'s offers are spent', () => {
    const held = [win('Code', 'a.ts', 0), tick(HOLD_MS / 1000)];
    // A sure answer weighs 2 x 0.9 = 1.8: under a bar of 2 no call is worth spending.
    expect(run({ ...base(), config: { ...base().config, offerBar: 2 } }, held).asked).toHaveLength(0);
    expect(run({ ...base(), config: { ...base().config, offerBar: 1.7 } }, held).asked).toHaveLength(1);
    // Four offers were said today: the gate would refuse a fifth, so it is not asked. Yesterday's four do not count.
    const s = base();
    expect(run({ ...s, notices: { ...s.notices, offersSaid: { day: '2026-03-10', n: 4 } } }, held).asked).toHaveLength(0);
    expect(run({ ...s, notices: { ...s.notices, offersSaid: { day: '2026-03-09', n: 4 } } }, held).asked).toHaveLength(1);
  });

  it('asks at most once per ASK_GAP_MS, whatever the app', () => {
    const { state } = run(base(), [win('Code', 'a.ts', 0), tick(HOLD_MS / 1000)]);
    const soon = HOLD_MS / 1000 + 10;
    expect(run(state, [win('Figma', 'Board', soon), tick(soon + HOLD_MS / 1000)]).asked).toHaveLength(0);
    expect(run(state, [win('Figma', 'Board', soon), tick(HOLD_MS / 1000 + ASK_GAP_MS / 1000)]).asked).toHaveLength(1);
  });
});

describe('offerNow: the answer', () => {
  it('parses an offer, and reads none, a guess or junk as no offer', () => {
    expect(parseOffer(OFFER)).toEqual({ offer: 'Want me to pull up the CI log for the failing build?', confidence: 0.8 });
    expect(parseOffer('```json\n{"offer": "none"}\n```')).toBeNull();
    expect(parseOffer('{"offer": "Want a summary?", "confidence": 0.3}')).toBeNull();
    expect(parseOffer('none')).toBeNull();
  });

  it('turns an offer into an offer-now candidate keyed by app, and drops one for a window the owner left', () => {
    const { state } = run(base(), [win('Code', 'a.ts', 0), tick(HOLD_MS / 1000)]);
    const out = offerNow(state, answer(OFFER, 'Code', 'a.ts', 130));
    const emitted = out.effects[0] as Extract<Effect, { type: 'EmitEvent' }>;
    expect(emitted.event.type).toBe('notice:candidate');
    expect(emitted.event.payload).toMatchObject({ kind: 'offer-now', key: 'offer-now:code', shape: 'transition', surprise: 2, precision: 0.8, observation: 'Want me to pull up the CI log for the failing build?' });
    expect(offerNow(state, answer('{"offer":"none"}', 'Code', 'a.ts', 130)).effects).toHaveLength(0);
    const moved = run(state, [win('Figma', 'Board', 125)]).state;
    expect(offerNow(moved, answer(OFFER, 'Code', 'a.ts', 130)).effects).toHaveLength(0);
  });
});

/**
 * The whole fold with a fake model: what the kernel runtime does, minus IO. A `ScheduleLLM` for `offer` is dispatched
 * (`llm:dispatched`, so the budget counts) and answered with `reply`; every `EmitEvent` is folded in its own pass.
 */
function harness(state: KernelState, reply: (messages: string) => string) {
  const notified: Extract<Effect, { type: 'Notify' }>[] = [];
  const decisions: unknown[] = [];
  const fold = (event: SanitizedEvent) => {
    const out = reduce(state, event, RULE_MANIFEST);
    state = out.state;
    for (const { effect } of out.effects) {
      if (effect.type === 'EmitEvent') fold({ ...effect.event, sanitized: true } as SanitizedEvent);
      else if (effect.type === 'Notify') notified.push(effect);
      else if (effect.type === 'RecordGateDecision') decisions.push(effect);
      else if (effect.type === 'ScheduleLLM' && effect.purpose === 'offer') {
        fold(ev('llm:dispatched', { purpose: 'offer' }, event.ts));
        fold(ev('llm:result', { purpose: 'offer', momentId: effect.momentId, text: reply(effect.messages.map((m) => m.content).join('\n')), metadata: effect.metadata }, event.ts));
      }
    }
  };
  return { fold, notified, decisions, state: () => state };
}

describe('offerNow through the gate (a ProactiveBench-shaped trace, fake model)', () => {
  // ProactiveBench's events as convert.mjs writes them: a few window rows, no errors, then time passes (bench ticks).
  const trace = [win('Google Chrome', 'Search: flights to Lisbon', 0), win('Google Chrome', 'TAP Air Portugal - Book', 40), win('Microsoft Excel', 'trip-budget.xlsx', 95)];

  it('produces a candidate the gate delivers, where before it had nothing to say', () => {
    const h = harness(base(), (prompt) => (prompt.includes('trip-budget.xlsx') ? JSON.stringify({ offer: 'Want me to add the TAP fare you just looked at to trip-budget.xlsx?', confidence: 0.85 }) : '{"offer":"none"}'));
    for (const e of trace) h.fold(e);
    for (let s = 120; s <= 95 + HOLD_MS / 1000 + 60; s += 60) h.fold(tick(s));
    const said = h.notified.filter((n) => (n.payload as { noticeKey?: string }).noticeKey === 'offer-now:microsoft excel');
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said[0]!.payload)).toContain('trip-budget.xlsx');
    expect(h.state().budgets.byPurpose.offer.callsToday).toBe(1);
    // Before: the same trace with the producer off has nothing to say.
    const before = harness(base({ offerNow: false }), () => OFFER);
    for (const e of trace) before.fold(e);
    for (let s = 120; s <= 95 + HOLD_MS / 1000 + 60; s += 60) before.fold(tick(s));
    expect(before.notified).toHaveLength(0);
  });

  it('the gate still decides: with the owner silent it says nothing, and the same offer twice in one app is said once', () => {
    // The rule's own candidate, put to the gate on a state where the owner turned Gnomon silent.
    const { state } = run(base(), [win('Code', 'a.ts', 0), tick(HOLD_MS / 1000)]);
    const candidate = (offerNow(state, answer(OFFER, 'Code', 'a.ts', 130)).effects[0] as Extract<Effect, { type: 'EmitEvent' }>).event;
    const silent = noticeGate({ ...state, settings: { ...state.settings, autonomy: 'off' } }, { ...candidate, sanitized: true } as SanitizedEvent);
    expect(silent.effects.some((e) => e.type === 'Notify')).toBe(false);
    expect(silent.effects.find((e) => e.type === 'RecordGateDecision')).toMatchObject({ channel: 'suppressed', reason: 'owner-silent' });

    const h = harness(base(), () => OFFER);
    h.fold(win('Code', 'a.ts', 0));
    h.fold(tick(HOLD_MS / 1000));
    h.fold(win('Code', 'b.ts', 3600));
    h.fold(tick(3600 + HOLD_MS / 1000));
    h.fold(win('Code', 'c.ts', 7200));
    h.fold(tick(7200 + HOLD_MS / 1000));
    // The first is said; after it, a sure answer could no longer clear the bar in Code, so no call is spent there.
    expect(h.notified.filter((n) => (n.payload as { noticeKey?: string }).noticeKey === 'offer-now:code')).toHaveLength(1);
    expect(h.state().budgets.byPurpose.offer.callsToday).toBe(1);
    expect(h.state().notices.habituation['offer-now:code']?.fires).toBeGreaterThanOrEqual(1);
  });
});
