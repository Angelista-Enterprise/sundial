import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { APPROVAL_GONE_MS, DAY_TYPES, openApprovals, readDayDoing, readDoing } from '@sundial/kernel/read/doing.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { OPEN_KEPT, RECENT_KEPT, approvalTrack } from './approval-track.js';

const T0 = Date.parse('2026-11-15T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown>): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });
/** The row the gate writes (gate.js decisionRecord: callRecord without its outcome, the verdict, the inputs with callFacts' facts). */
const decided = (sec: number, callId: string, final: Record<string, unknown> | null = null) =>
  ev('action:decided', sec, { tool: 'screen_act', server: null, action: 'screen_act', callId, verdict: 'ask', reason: 'Gnomon: screen_act always asks: it acts in another app on your screen.', inputs: { preset: 'workspace-write', autonomy: 'ask', testMode: false, facts: { destructive: null, saidByOwner: false, integration: null, final, typing: null, private: null } } });
const asked = (sec: number, id: string, extra: Record<string, unknown> = {}) => ev('approval:asked', sec, { approvalId: id, sessionId: 'session-7f', tool: 'screen_act', ...extra });
const answered = (sec: number, id: string, answer = 'allowed-once', by = 'owner') => ev('approval:answered', sec, { approvalId: id, sessionId: 'session-7f', tool: 'screen_act', answer, by });
const fold = (events: SanitizedEvent[], state: KernelState = createInitialState('d1')) => events.reduce((s, e) => approvalTrack(s, e).state, state);

describe('approvalTrack (Round 2: the approvals slice)', () => {
  it('an ask is open with its line, the time, and its chat', () => {
    const state = fold([asked(0, 'approval-1', { callId: 'call-3', text: 'Press "Send" in Mail' })]);
    expect(state.approvals?.open).toEqual([{ id: 'approval-1', sessionId: 'session-7f', tool: 'screen_act', callId: 'call-3', kind: 'plain', line: 'Press "Send" in Mail', at: at(0) }]);
  });

  it('an answer closes it into recent, with who answered and when', () => {
    const state = fold([asked(0, 'approval-1'), answered(4, 'approval-1')]);
    expect(state.approvals?.open).toEqual([]);
    expect(state.approvals?.recent).toMatchObject([{ id: 'approval-1', answer: 'allowed-once', by: 'owner', answeredAt: at(4) }]);
    // An answer to nothing open changes nothing.
    const again = fold([answered(5, 'approval-1')], state);
    expect(again).toBe(state);
  });

  it('joins the kind from the call\'s action:decided, in either order; never an app, an address or a command', () => {
    const first = fold([decided(0, 'call-3', { kind: 'send', via: 'screen', blind: false }), asked(1, 'approval-1', { callId: 'call-3' })]);
    expect(first.approvals?.open[0]).toEqual({ id: 'approval-1', sessionId: 'session-7f', tool: 'screen_act', callId: 'call-3', kind: 'send', line: null, at: at(1) });
    const late = fold([asked(0, 'approval-2', { callId: 'call-4' }), decided(1, 'call-4', { kind: 'delete', via: 'shell', blind: false })]);
    expect(late.approvals?.open[0]).toMatchObject({ kind: 'delete', callId: 'call-4' });
    expect(fold([decided(0, 'call-5'), asked(1, 'approval-3', { callId: 'call-5' })]).approvals?.open[0].kind).toBe('plain');
    // No decided row (a judge's escalation, a dsh ask): the kind the ask itself carried.
    expect(fold([asked(0, 'approval-4', { kind: 'pay' })]).approvals?.open[0].kind).toBe('pay');
    expect(JSON.stringify(first.approvals)).not.toMatch(/Gnomon: screen_act|workspace-write/);
  });

  it('stays bounded: open, recent and the decided calls', () => {
    const many = Array.from({ length: RECENT_KEPT + 5 }, (_, i) => [decided(i, `call-${i}`), asked(i, `approval-${i}`, { callId: `call-${i}` })]).flat();
    const open = fold(many);
    expect(open.approvals?.open).toHaveLength(OPEN_KEPT);
    expect(open.approvals?.open.at(-1)?.id).toBe(`approval-${RECENT_KEPT + 4}`);
    expect(open.approvals?.decided).toHaveLength(20);
    const closedAll = fold(Array.from({ length: RECENT_KEPT + 5 }, (_, i) => [asked(i, `a-${i}`), answered(i, `a-${i}`)]).flat());
    expect(closedAll.approvals?.recent).toHaveLength(RECENT_KEPT);
    expect(closedAll.approvals?.recent.at(-1)?.id).toBe(`a-${RECENT_KEPT + 4}`);
  });

  it('an ask nobody answered, not even the shell\'s timer, closes by the fold\'s clock', () => {
    const open = fold([asked(0, 'approval-1')]);
    expect(fold([ev('clock:tick', 300, {})], open)).toBe(open);
    const gone = fold([ev('clock:tick', APPROVAL_GONE_MS / 1000, {})], open);
    expect(gone.approvals?.open).toEqual([]);
    expect(gone.approvals?.recent).toMatchObject([{ id: 'approval-1', answer: 'rejected', by: 'timeout' }]);
  });

  it('readDoing composes the task, the last look and act, the open asks and the last answers', () => {
    const state = fold([asked(0, 'approval-1'), asked(1, 'approval-2'), answered(2, 'approval-2', 'rejected')], { ...createInitialState('d1'), task: { id: 't1', at: at(0), session: 'session-7f', said: 'send the report' }, marks: { now: [], guide: null, guideTally: {}, lastAct: { id: 'act-1', outcome: 'performed', proof: 'unconfirmed' } } });
    const doing = readDoing(state, T0 + 10_000);
    expect(doing).toMatchObject({ task: { id: 't1' }, act: { id: 'act-1', proof: 'unconfirmed' }, look: null, asks: [{ id: 'approval-1' }], allowed: [{ id: 'approval-2', answer: 'rejected' }] });
    expect(openApprovals(state, T0 + APPROVAL_GONE_MS + 1)).toEqual([]);
    expect(openApprovals(state, T0, 'session-other')).toEqual([]);
  });

  it('readDoing names the owner\'s own newest task, never a rig chat\'s newer one (Set 5 R1)', () => {
    const mine = { id: 't1', at: at(0), session: 'session-7f', said: 'send the report' };
    const rig = { id: 't2', at: at(5), session: 'session-rig', said: 'rename the files' };
    const state = { ...createInitialState('d1'), task: rig, tasks: { 'session-7f': mine, 'session-rig': rig }, rigSessions: { 'session-rig': at(0) } } as unknown as KernelState;
    expect(readDoing(state, T0 + 10_000).task).toMatchObject({ id: 't1' });
    // A snapshot from before Set 5 holds only `task`: it is the owner's when its chat is.
    expect(readDoing({ ...createInitialState('d1'), task: mine }, T0).task).toMatchObject({ id: 't1' });
    expect(readDoing({ ...createInitialState('d1'), task: rig, rigSessions: { 'session-rig': at(0) } } as unknown as KernelState, T0).task).toBeNull();
  });

  it('the day line counts the day\'s log rows of the owner\'s chats: steps, apps, asks, yeses; a rig session and yesterday left out (Round 5)', async () => {
    const row = (type: string, capturedAt: string, data: Record<string, unknown>) => ({ signalType: type.split(':')[0]!, eventType: type.split(':')[1]!, data, capturedAt });
    const step = (sec: number, session: string, processName: string) => row('screen:step', at(sec), { id: `act-${sec}`, session, processName, verb: 'press' });
    const ask = (sec: number, sessionId: string, id: string) => row('approval:asked', at(sec), { approvalId: id, sessionId, tool: 'screen_act' });
    const answer = (sec: number, sessionId: string, id: string, answer: string, by = 'owner') => row('approval:answered', at(sec), { approvalId: id, sessionId, tool: 'screen_act', answer, by });
    const log = [
      // Yesterday by the owner's clock (Amsterdam midnight is 23:00Z): not today.
      row('screen:step', '2026-11-14T22:30:00.000Z', { session: 'session-7f', processName: 'Calendar' }),
      step(0, 'session-7f', 'Obsidian'), step(1, 'session-7f', 'obsidian'), step(2, 'session-7f', 'Mail'), step(3, 'session-8a', 'Zen'),
      ask(4, 'session-7f', 'approval-1'), answer(5, 'session-7f', 'approval-1', 'allowed-once'),
      ask(6, 'session-7f', 'approval-2'), answer(7, 'session-7f', 'approval-2', 'rejected'),
      ask(8, 'session-8a', 'approval-3'), answer(9, 'session-8a', 'approval-3', 'rejected', 'timeout'),
      // The rig's chat: steps in other apps, an ask and a yes by the rig.
      step(10, 'session-rig', 'Testbox'), step(11, 'session-rig', 'Notes'), ask(12, 'session-rig', 'approval-4'), answer(13, 'session-rig', 'approval-4', 'allowed-once', 'rig'),
      row('screen:looked', at(14), { session: 'session-7f', processName: 'Safari' }),
    ];
    const rows = async (from: string, to: string, types: string[]) => log.filter((r) => r.capturedAt >= from && r.capturedAt < to && types.includes(`${r.signalType}:${r.eventType}`));
    const state = { ...createInitialState('d1'), rigSessions: { 'session-rig': at(0) } };
    const day = await readDayDoing({ state, now: T0 + 60_000, timeZone: 'Europe/Amsterdam', rows });
    const today = log.filter((r) => r.capturedAt >= '2026-11-14T23:00:00.000Z' && r.data.session !== 'session-rig' && r.data.sessionId !== 'session-rig');
    const n = (type: string) => today.filter((r) => `${r.signalType}:${r.eventType}` === type);
    expect(day).toEqual({ steps: n('screen:step').length, apps: 3, asked: n('approval:asked').length, yes: 1, line: 'Gnomon did 4 steps in 3 apps today, asked 3 times, you said yes 1.' });
    expect([day.steps, day.asked]).toEqual([4, 3]);
    expect(DAY_TYPES).not.toContain('screen:looked');
    // The rig's own rows counted would say otherwise; a day with nothing done and nothing asked has no line.
    expect((await readDayDoing({ state: createInitialState('d1'), now: T0 + 60_000, timeZone: 'Europe/Amsterdam', rows })).steps).toBe(6);
    expect((await readDayDoing({ state, now: T0 + 60_000, timeZone: 'Europe/Amsterdam', rows: async () => [] })).line).toBeNull();
  });
});
