import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { capabilityOf, levelOf } from '@sundial/kernel/autonomy.js';
import type { KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { autonomyTrack } from './autonomy-track.js';
import { noticeGate } from './notice-gate.js';

let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, ts = '2026-09-29T10:00:00.000Z'): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const judged = (s: KernelState, kind: string, n: number, hits: number) => {
  s.calibrated.params[`notice.precision:${kind}`] = { n, hits, sum: hits, updatedAt: null };
  return s;
};
const fold = (s: KernelState, events: SanitizedEvent[]) => events.reduce((x, e) => autonomyTrack(x, e).state, s);

describe('state.autonomy (W5 step 10)', () => {
  it('everything asks by default; act needs the rows AND the owner\'s yes; below target it asks again', () => {
    let s = judged(createInitialState('d1'), 'agent-waiting', 30, 27);
    expect(levelOf(s, 'notice:agent-waiting')).toBe('ask');
    s = fold(s, [ev('day:boundary')]);
    expect(s.autonomy.levels['notice:agent-waiting']).toMatchObject({ level: 'ask', earned: true });
    s = fold(s, [ev('autonomy:granted', { capability: 'notice:agent-waiting' })]);
    expect(levelOf(s, 'notice:agent-waiting')).toBe('act');
    // Six wrong verdicts later it is at 27 / 36 = 75%: back to asking, the yes kept for when it earns it again.
    s = fold(judged(s, 'agent-waiting', 36, 27), [ev('feedback:verdict')]);
    expect(s.autonomy.levels['notice:agent-waiting']).toMatchObject({ level: 'ask', earned: false });
    expect(s.autonomy.granted['notice:agent-waiting']).toBeDefined();
  });

  it('a yes alone raises nothing: 29 verdicts is not the stated n', () => {
    const s = fold(judged(createInitialState('d1'), 'agent-waiting', 29, 29), [ev('autonomy:granted', { capability: 'notice:agent-waiting' })]);
    expect(levelOf(s, 'notice:agent-waiting')).toBe('ask');
  });

  it('the owner can always lower it, and lift the ceiling again', () => {
    let s = fold(judged(createInitialState('d1'), 'agent-waiting', 40, 40), [ev('autonomy:granted', { capability: 'notice:agent-waiting' }), ev('autonomy:set', { capability: 'notice:agent-waiting', level: 'off' })]);
    expect(levelOf(s, 'notice:agent-waiting')).toBe('off');
    s = fold(s, [ev('autonomy:set', { capability: 'actions', level: 'off' }), ev('autonomy:set', { capability: 'notice:agent-waiting', level: 'act' })]);
    expect(levelOf(s, 'notice:agent-waiting')).toBe('act');
    expect(levelOf(s, 'actions')).toBe('off');
    // A capability that does not exist is not recorded.
    expect(fold(s, [ev('autonomy:granted', { capability: 'notice:made-up' })]).autonomy.granted['notice:made-up']).toBeUndefined();
  });

  it('the owner\'s own reminders, Sundial\'s health and adopted watch rules are not Gnomon\'s to earn', () => {
    expect(capabilityOf('wakeup')).toBeNull();
    expect(capabilityOf('sensor-health')).toBeNull();
    expect(capabilityOf('watch:ci-failed')).toBeNull();
    expect(capabilityOf('followup:unpushed')).toBe('followups');
    expect(levelOf(createInitialState('d1'), null)).toBe('act');
  });
});

describe('the gate under autonomy (W5 step 10)', () => {
  const urgent = (kind: string): NoticeCandidate => ({ shape: 'transition', kind, key: `${kind}:1`, surprise: 3, precision: 1, valueHalfLifeMs: 30 * 60_000, observation: 'Your Claude session in puzzlebox-studio is waiting.', evidence: [], concerns: [] });
  const gate = (s: KernelState, c: NoticeCandidate) => noticeGate({ ...s, config: { ...s.config, timezone: 'UTC' } }, ev('notice:candidate', c as unknown as Record<string, unknown>)).effects;
  const channel = (effects: ReturnType<typeof gate>) => (effects.find((e) => e.type === 'RecordGateDecision') as { channel: string; reason: string } | undefined);

  it('a kind that asks is said in the list, not as an interruption; one that acts interrupts', () => {
    expect(channel(gate(createInitialState('d1'), urgent('agent-waiting')))).toMatchObject({ channel: 'tonic', reason: 'autonomy-ask' });
    // Said in the list, not charged to the list's daily budget: the ambient notices keep their four.
    const listed = noticeGate({ ...createInitialState('d1'), config: { ...createInitialState('d1').config, timezone: 'UTC' } }, ev('notice:candidate', urgent('agent-waiting') as unknown as Record<string, unknown>));
    expect(listed.state.notices.spentToday).toBe(0);
    expect(listed.effects.find((e) => e.type === 'Notify')).toMatchObject({ channel: 'tonic-notice' });
    const s = createInitialState('d1');
    s.autonomy.levels['notice:agent-waiting'] = { level: 'act', earned: true, since: '2026-09-01T00:00:00.000Z' };
    expect(channel(gate(s, urgent('agent-waiting')))).toMatchObject({ channel: 'phasic' });
    // A reminder the owner asked for interrupts whatever the scorecard says.
    expect(channel(gate(createInitialState('d1'), urgent('wakeup')))).toMatchObject({ channel: 'phasic' });
  });

  it('a capability the owner turned off says nothing, recorded as their own quiet', () => {
    const s = createInitialState('d1');
    s.autonomy.lowered.followups = 'off';
    expect(channel(gate(s, { ...urgent('followup:unpushed'), valueHalfLifeMs: null }))).toMatchObject({ channel: 'suppressed', reason: 'owner-quiet' });
  });
});
