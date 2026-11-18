// S6: offers of help clear their own bar (`config.offerBar`); every other notice keeps the gate's 1.6, and every guard
// the owner has (silence, quiet, a call or focus, habituation, "not now", the day's caps) still holds an offer.
import { decide, DEFAULT_GATE_POLICY, policyForBias } from '@sundial/kernel/gate.js';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { DEFAULT_SUNDIAL_CONFIG } from '@sundial/helpers/sundial-config.js';

const DEFAULT_OFFER_BAR = DEFAULT_SUNDIAL_CONFIG.offerBar;
import { describe, expect, it } from 'vitest';
import { feedbackTrack } from './feedback-track.js';
import { interruptionCostOf, noticeGate } from './notice-gate.js';

const T0 = Date.parse('2026-03-10T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): SanitizedEvent => ({ id: `ob${++seq}`, type, ts, payload, sanitized: true });
/** An offer as `offerNow` raises it: surprise 2, the model's confidence as precision, a ten-minute half-life. */
const offer = (app: string, confidence = 0.55, over: Partial<NoticeCandidate> = {}): NoticeCandidate => ({ shape: 'transition', kind: 'offer-now', key: `offer-now:${app.toLowerCase()}`, surprise: 2, precision: confidence, valueHalfLifeMs: 600_000, observation: 'Want me to pull up the CI log for puzzlebox-studio?', evidence: [], concerns: [], ...over });
/** The same weight and half-life, any other kind. */
const notice = (kind = 'stuck', confidence = 0.55): NoticeCandidate => ({ ...offer('x', confidence), kind, key: `${kind}:x` });
/** A fresh state where offers may interrupt (`act`), so a verdict shows the bar and not the ask-first rule. */
const base = (over: Partial<KernelState['config']> = {}): KernelState => {
  const s = createInitialState('ob');
  return { ...s, config: { ...s.config, timezone: 'UTC', ...over }, autonomy: { ...s.autonomy, levels: { 'notice:offer-now': { level: 'act', earned: true, since: at(0) }, 'notice:stuck': { level: 'act', earned: true, since: at(0) } } } };
};
const record = (effects: Effect[]) => effects.find((e) => e.type === 'RecordGateDecision') as Extract<Effect, { type: 'RecordGateDecision' }>;
const said = (effects: Effect[]) => effects.filter((e) => e.type === 'Notify');
const gate = (s: KernelState, c: NoticeCandidate, min = 0) => noticeGate(s, ev('notice:candidate', { ...c }, at(min)));
const empty = { habituation: {}, day: '2026-03-10', spentToday: 0, phasicToday: 0 };

describe('the offers bar (S6)', () => {
  it('an offer at confidence 0.55 interrupts against its own bar, where the same weight of any other kind stays under 1.6', () => {
    const policy = policyForBias(0);
    // One default, said twice (the kernel may not read the config module): config.offerBar and the gate's own.
    expect(DEFAULT_GATE_POLICY.offerThreshold).toBe(DEFAULT_OFFER_BAR);
    expect(policy.offerThreshold).toBe(DEFAULT_OFFER_BAR);
    expect(decide(policy, empty, offer('Code'), at(0), '2026-03-10', 0)).toMatchObject({ channel: 'phasic', reason: 'admitted' });
    expect(decide(policy, empty, notice(), at(0), '2026-03-10', 0)).toMatchObject({ channel: 'suppressed', reason: 'below-threshold' });
    // Through the rule: said, and the decision row records the bar it was weighed against.
    const out = gate(base(), offer('Code'));
    expect(said(out.effects)).toHaveLength(1);
    expect(record(out.effects)).toMatchObject({ kind: 'offer-now', channel: 'phasic', phasicBar: DEFAULT_OFFER_BAR });
  });

  it('every other notice is weighed exactly as before: the bar is 1.6 and its row says so', () => {
    expect(policyForBias(0).phasicThreshold).toBe(1.6);
    expect(DEFAULT_GATE_POLICY.phasicThreshold).toBe(1.6);
    const out = gate(base(), notice('stuck', 0.55));
    expect(said(out.effects)).toHaveLength(0);
    expect(record(out.effects)).toMatchObject({ channel: 'suppressed', reason: 'below-threshold', phasicBar: 1.6 });
    expect(decide(policyForBias(0), empty, notice('stuck', 0.85), at(0), '2026-03-10', 0)).toMatchObject({ channel: 'phasic' });
  });

  it("the owner's dial moves the offers bar with the others", () => {
    expect(policyForBias(1).offerThreshold).toBe(2 * DEFAULT_OFFER_BAR);
    expect(policyForBias(-1).offerThreshold).toBe(DEFAULT_OFFER_BAR / 2);
    const louder = { ...base(), settings: { ...base().settings, noticeBias: 1 } };
    expect(said(gate(louder, offer('Code')).effects)).toHaveLength(0);
  });

  it('config.offerBar overrides the default, in the gate and in the ask', () => {
    const strict = base({ offerBar: 1.5 });
    expect(said(gate(strict, offer('Code')).effects)).toHaveLength(0);
    expect(record(gate(strict, offer('Code')).effects)).toMatchObject({ reason: 'below-threshold', phasicBar: 1.5 });
    expect(said(gate(base({ offerBar: 0.6 }), offer('Code', 0.5)).effects)).toHaveLength(1);
  });

  it('pays the interruption cost like any interruption: an expensive moment holds an offer rather than breaking in', () => {
    const s = base();
    const cost = interruptionCostOf(s, at(0));
    const out = decide(policyForBias(0), empty, offer('Code'), at(0), '2026-03-10', 1);
    expect(out.utility).toBeCloseTo(1.1 - 0.8, 5);
    expect(out.channel).toBe('deferred');
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe('the owner guards still hold an offer', () => {
  it('silence and a quieted offers group say nothing', () => {
    const silent = { ...base(), settings: { ...base().settings, autonomy: 'off' as const } };
    expect(record(gate(silent, offer('Code')).effects)).toMatchObject({ channel: 'suppressed', reason: 'owner-silent' });
    const quiet = { ...base(), settings: { ...base().settings, quiet: ['offers'] } } as KernelState;
    expect(record(gate(quiet, offer('Code')).effects)).toMatchObject({ channel: 'suppressed', reason: 'owner-quiet' });
  });

  it('a call or a focus mode holds it', () => {
    for (const reason of ['call', 'focus'] as const) {
      const s = { ...base(), route: { channel: 'hold' as const, reason, since: at(0), awaySince: null } } as KernelState;
      const out = gate(s, offer('Code'));
      expect(said(out.effects)).toHaveLength(0);
      expect(record(out.effects)).toMatchObject({ channel: 'deferred', reason: reason === 'call' ? 'held-call' : 'held-focus' });
    }
  });

  it('not yet trusted to act, an offer that clears its bar asks first in the list instead of interrupting', () => {
    const s = { ...base(), autonomy: createInitialState('ob').autonomy };
    const out = gate(s, offer('Code'));
    expect(out.effects.some((e) => e.type === 'Notify' && e.channel === 'phasic-notice')).toBe(false);
    expect(record(out.effects)).toMatchObject({ channel: 'tonic', reason: 'autonomy-ask' });
  });

  it('habituates: the same app is not offered again that day, and a "not now" quiets an app never offered', () => {
    const first = gate(base(), offer('Code'));
    expect(said(first.effects)).toHaveLength(1);
    expect(record(gate(first.state, offer('Code'), 60).effects)).toMatchObject({ channel: 'suppressed', reason: 'habituated' });
    const notNow = feedbackTrack(base(), ev('feedback:verdict', { artifactKind: 'notice', artifactId: 'offer-now:figma', verdict: 'not-now' }, at(1))).state;
    expect(said(gate(notNow, offer('Figma'), 2).effects)).toHaveLength(0);
  });

  it('a day says at most offerDailyCap offers, whatever the apps, and one app said twice counts twice', () => {
    let s = base({ offerBar: 0.3 });
    // At this bar a second offer in Code clears even habituated (2 x 0.55 x 0.4 = 0.44).
    const apps = ['Code', 'Code', 'Mail', 'Notes', 'Xcode', 'Slack'];
    const out = apps.map((app, i) => {
      const r = gate(s, offer(app), i * 30);
      s = r.state;
      return r;
    });
    expect(out.filter((r) => said(r.effects).length > 0)).toHaveLength(DEFAULT_GATE_POLICY.offerDailyCap!);
    expect(record(out[5]!.effects)).toMatchObject({ channel: 'suppressed', reason: 'offers-spent' });
    // A new day starts the count again, and the cap counts offers only.
    expect(s.notices.offersSaid).toEqual({ day: '2026-03-10', n: DEFAULT_GATE_POLICY.offerDailyCap });
    expect(said(gate(s, offer('Slack'), 24 * 60).effects)).toHaveLength(1);
    expect(said(gate(s, notice('stuck', 0.85), 200).effects)).toHaveLength(1);
  });

  it("the day's interruption cap still applies: past it an offer is only a list row", () => {
    const s = base();
    const full = { ...s, notices: { ...s.notices, recentPhasic: Array.from({ length: DEFAULT_GATE_POLICY.phasicDailyCap }, (_, i) => ({ kind: 'stuck', observation: 'x', evidence: [], weight: 2, at: at(-60 + i), noticeKey: `stuck:${i}` })) } };
    const out = gate(full, offer('Code'));
    expect(out.effects.some((e) => e.type === 'Notify' && e.channel === 'phasic-notice')).toBe(false);
  });
});
