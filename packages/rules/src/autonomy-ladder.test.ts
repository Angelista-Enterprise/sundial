// Round 3, the ladder: the owner's answers to plain acts, joined by approvalTrack, folded by autonomyTrack. Every value is made up.
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { approvalTrack } from './approval-track.js';
import { LADDER_KEPT, autonomyTrack } from './autonomy-track.js';

const T0 = Date.parse('2026-11-15T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown>): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });
/** One ask and its answer, as the gate and the shell write them: action:decided (facts.app for a plain act), approval:asked, approval:answered. */
const round = (n: number, { app = 'TextEdit', final = null as Record<string, unknown> | null, answer = 'allowed-once', by = 'owner' as string | null } = {}): SanitizedEvent[] => [
  ev('action:decided', n * 10, { tool: 'screen_act', callId: `call-${n}`, verdict: 'ask', inputs: { facts: { final, app: final ? null : app, typing: null, private: false } } }),
  ev('approval:asked', n * 10 + 1, { approvalId: `approval-${n}`, sessionId: 'session-7f', tool: 'screen_act', callId: `call-${n}` }),
  ev('approval:answered', n * 10 + 2, { approvalId: `approval-${n}`, sessionId: 'session-7f', tool: 'screen_act', answer, ...(by === null ? {} : { by }) }),
];
// Both rules in manifest order: approvalTrack before autonomyTrack on the same event.
const fold = (events: SanitizedEvent[], state: KernelState = createInitialState('d1')) => events.reduce((s, e) => autonomyTrack(approvalTrack(s, e).state, e).state, state);
const rounds = (from: number, count: number, opts?: Parameters<typeof round>[1]) => Array.from({ length: count }, (_, i) => round(from + i, opts)).flat();
const rung = (s: KernelState, app = 'TextEdit') => s.autonomy.ladder?.find((r) => r.tool === 'screen_act' && r.app === app);

describe('autonomyTrack: the ladder (Round 3)', () => {
  it('k owner yeses in a row climb to k, at event time', () => {
    const s = fold(rounds(0, 10));
    expect(rung(s)).toEqual({ tool: 'screen_act', app: 'TextEdit', yes: 10, at: at(92) });
  });

  it('a no puts it back to 0, and it needs k again', () => {
    let s = fold([...rounds(0, 9), ...round(9, { answer: 'rejected' })]);
    expect(rung(s)?.yes).toBe(0);
    s = fold(rounds(10, 3), s);
    expect(rung(s)?.yes).toBe(3);
  });

  it('a final never climbs, in any number, and its no does not touch the plain rung', () => {
    const s = fold([...rounds(0, 4), ...rounds(4, 30, { final: { kind: 'send', via: 'screen', blind: false } }), ...round(40, { final: { kind: 'delete', via: 'screen', blind: false }, answer: 'rejected' })]);
    expect(s.autonomy.ladder).toHaveLength(1);
    expect(rung(s)?.yes).toBe(4);
  });

  it('a private app never climbs: the gate names no app for it, so the record has none', () => {
    const s = fold(rounds(0, 20, { app: '' }));
    expect(s.autonomy.ladder ?? []).toEqual([]);
  });

  it('the rig\'s answers, a timeout and a withdrawn ask move nothing', () => {
    const s = fold([...rounds(0, 20, { by: 'rig' }), ...round(20, { answer: 'rejected', by: 'timeout' }), ...round(21, { answer: 'cancelled', by: 'asker' })]);
    expect(s.autonomy.ladder ?? []).toEqual([]);
    const owner = fold([...rounds(30, 5), ...round(40, { answer: 'rejected', by: 'rig' })]);
    expect(rung(owner)?.yes).toBe(5);
  });

  it('an answer with no by, or a strange one, is unknown and moves nothing (an old yes.mjs that forgets by: rig)', () => {
    const s = fold([...rounds(0, 10, { by: null }), ...rounds(10, 10, { by: 'someone' })]);
    expect(s.approvals?.recent.map((r) => r.by)).toEqual(Array(20).fill('unknown'));
    expect(s.autonomy.ladder ?? []).toEqual([]);
  });

  it('per app: yeses in one app are not yeses in another', () => {
    const s = fold([...rounds(0, 3), ...rounds(3, 2, { app: 'Finder' })]);
    expect([rung(s)?.yes, rung(s, 'Finder')?.yes]).toEqual([3, 2]);
  });

  it('the owner\'s reset clears one app, or every app', () => {
    const s = fold([...rounds(0, 3), ...rounds(3, 2, { app: 'Finder' })]);
    const one = fold([ev('autonomy:set', 100, { reset: 'textedit', by: 'owner' })], s);
    expect(one.autonomy.ladder?.map((r) => r.app)).toEqual(['Finder']);
    expect(fold([ev('autonomy:set', 100, { reset: true, by: 'owner' })], s).autonomy.ladder).toEqual([]);
  });

  it('bounded, and the same log folds to the same ladder', () => {
    const many = Array.from({ length: LADDER_KEPT + 10 }, (_, i) => round(i, { app: `App ${i}` })).flat();
    const s = fold(many);
    expect(s.autonomy.ladder).toHaveLength(LADDER_KEPT);
    expect(s.autonomy.ladder?.[0].app).toBe('App 10');
    expect(fold(many).autonomy.ladder).toEqual(s.autonomy.ladder);
  });
});
