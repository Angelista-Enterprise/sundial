// Round 4: the rig's chat sessions on the record, and every owner learner skipping them. Every value is made up.
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { DeliveredNotice, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { approvalTrack } from './approval-track.js';
import { autonomyTrack } from './autonomy-track.js';
import { calibrate } from './calibrate.js';
import { conversationTrack } from './conversation-track.js';
import { RULE_MANIFEST } from './manifest.js';
import { RIG_SESSIONS_KEPT, rigSessions } from './rig-sessions.js';
import { routePromote } from './route-promote.js';

let seq = 0;
const T0 = Date.parse('2026-11-15T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts: at(sec), payload, sanitized: true });
const model = (sec: number, sessionId: string, extra: Record<string, unknown> = { rig: true }) => ev('thread:model', sec, { sessionId, provider: 'openai', model: 'test-2', ...extra });
const fold = (rule: typeof rigSessions, events: SanitizedEvent[], state: KernelState = createInitialState('d')) => events.reduce((s, e) => rule(s, e).state, state);
const RIG = fold(rigSessions, [model(0, 'session-rig')]);

describe('rigSessions: the fold', () => {
  it('records a thread:model with rig: true, at event time; the owner\'s own change and the companion say nothing', () => {
    const s = fold(rigSessions, [model(0, 'session-rig'), model(1, 'session-own', {}), model(2, 'gnomon-companion'), model(3, 'session-odd', { rig: 'yes' })]);
    expect(s.rigSessions).toEqual({ 'session-rig': at(0) });
    expect(isRigSession(s, 'session-rig')).toBe(true);
    expect(isRigSession(s, 'session-own')).toBe(false);
    expect(isRigSession(s, '')).toBe(false);
    expect(isRigSession(createInitialState('d'), 'session-rig')).toBe(false);
  });

  it('S4: a helper a rig chat starts is a rig chat (thread:delegate); one the owner\'s chat starts, or an unknown parent\'s, is not', () => {
    const s = fold(rigSessions, [model(0, 'session-rig'), ev('thread:delegate', 1, { sessionId: 'child-rig', parent: 'session-rig' }), ev('thread:delegate', 2, { sessionId: 'child-own', parent: 'session-own' }), ev('thread:delegate', 3, { sessionId: 'child-x' })]);
    expect(Object.keys(s.rigSessions!)).toEqual(['session-rig', 'child-rig']);
  });

  it('S4: the mark outlives a busy rig: a thousand kept, not fifty', () => {
    expect(RIG_SESSIONS_KEPT).toBe(1000);
  });

  it('keeps the newest RIG_SESSIONS_KEPT and the first-seen time; a resume moves a session to the end', () => {
    let s = fold(rigSessions, Array.from({ length: RIG_SESSIONS_KEPT }, (_, i) => model(i, `session-${i}`)));
    s = fold(rigSessions, [model(100, 'session-0'), model(101, 'session-new')], s);
    expect(Object.keys(s.rigSessions!)).toHaveLength(RIG_SESSIONS_KEPT);
    expect(s.rigSessions!['session-0']).toBe(at(0));
    expect(s.rigSessions!['session-1']).toBeUndefined();
    expect(Object.keys(s.rigSessions!).slice(-2)).toEqual(['session-0', 'session-new']);
  });

  // Fable H4: the owner is the rig's developer; their own words and their own Testbox mailbox never mark their chat.
  it('a task naming a rig fixture folder or Testbox, or a step in a Testbox window, marks nothing: only the rig\'s own thread:model row does', () => {
    const s = fold(rigSessions, [
      ev('chat:owner', 0, { sessionId: 'session-own', text: 'Why did /tmp/gnomon-run-x7/memo.txt fail in the Testbox task?' }),
      ev('task:started', 1, { sessionId: 'session-own', text: 'Clean up lab/screen-rig/data/fix.' }),
      ev('screen:step', 2, { session: 'session-own', processName: 'Mail', windowTitle: 'Inbox - Testbox', ok: false }),
      model(3, 'session-rig'),
    ]);
    expect(s.rigSessions).toEqual({ 'session-rig': at(3) });
    expect(isRigSession(s, 'session-own')).toBe(false);
  });

  it('runs before every owner learner in the manifest', () => {
    const names = RULE_MANIFEST.map((r) => r.name);
    const first = names.indexOf('rigSessions');
    expect(first).toBeGreaterThan(-1);
    for (const name of ['conversationTrack', 'loopTrack', 'routePromote', 'calibrate', 'autonomyTrack', 'commitmentTrack']) expect(names.indexOf(name), name).toBeGreaterThan(first);
  });
});

describe('every owner learner skips a rig session\'s turn and keeps an owner turn', () => {
  const PROMISE = 'I promised Mira Bakker I will send the draft by Tuesday.';
  const FACTS = [{ key: 'git.unpushed', value: { total: 263 } }];

  it('conversationTrack: no promise from a rig turn, nothing said or cited; the turns are kept', () => {
    const rig = conversationTrack(RIG, ev('chat:owner', 10, { sessionId: 'session-rig', turnId: 't1', text: PROMISE }));
    expect(rig.effects).toEqual([]);
    expect(rig.state.conversation.sessions['session-rig']?.turns).toHaveLength(1);
    const own = conversationTrack(RIG, ev('chat:owner', 10, { sessionId: 'session-own', turnId: 't1', text: PROMISE }));
    expect(own.effects).toHaveLength(1);

    const said = (sessionId: string) => {
      const shown = ev('chat:shown', 11, { sessionId, briefId: 'b1', facts: FACTS, cites: [{ id: 'f1', predicate: 'prefers', object: 'green tea' }] });
      return fold(conversationTrack, [shown, ev('chat:said', 12, { sessionId, turnId: 't1', text: '263 commits, and you like green tea.' })], RIG).conversation;
    };
    expect(said('session-rig').said).toEqual([]);
    expect(said('session-rig').cited ?? []).toEqual([]);
    expect(said('session-own').said).toHaveLength(1);
    expect(said('session-own').cited).toHaveLength(1);
  });

  it('ownerOnly (calibrate, commitmentTrack, ...): a chat row in a rig session reaches no wrapped rule', () => {
    const wrapped = RULE_MANIFEST.find((r) => r.name === 'calibrate')!;
    const line: DeliveredNotice = { key: 'followup:unpushed:puzzlebox-studio', kind: 'followup:unpushed', channel: 'tonic', cost: 0, evidence: [], sessionId: 'session-rig', askId: null };
    const delivered = (state: KernelState) => calibrate({ ...state, notices: { ...state.notices, lastDelivered: { at: at(0), items: [line] } } }, ev('notice:candidate', 0, { key: line.key })).state;
    const rig = delivered(RIG);
    const turn = ev('chat:owner', 40, { sessionId: 'session-rig', turnId: 't' });
    expect(wrapped(rig, turn).state).toBe(rig);
    const own = delivered(createInitialState('d'));
    expect(wrapped(own, turn).state.calibrated.params['notice.acted:followup:unpushed']).toMatchObject({ hits: 1 });
  });

  it('routePromote: a clean run in a rig session never offers; the same run in the owner\'s does', () => {
    const run = (session: string) => [ev('screen:step', 20, { processName: 'Spotify', verb: 'press', role: 'button', screenText: ['Play'], goal: 'play', session, ok: true, changed: true }), ev('action:performed', 21, { tool: 'screen_act', outcome: 'ok' })];
    const offers = (session: string) => {
      let state = RIG;
      const effects: unknown[] = [];
      for (const e of run(session)) {
        const out = routePromote(state, e);
        state = out.state;
        effects.push(...out.effects);
      }
      return effects;
    };
    expect(offers('session-rig')).toEqual([]);
    expect(offers('session-own')).toHaveLength(1);
  });

  it('the ladder: an owner yes in a rig session never earns; in the owner\'s it does', () => {
    const round = (n: number, sessionId: string): SanitizedEvent[] => [
      ev('action:decided', n * 10, { tool: 'screen_act', callId: `call-${n}`, verdict: 'ask', inputs: { facts: { final: null, app: 'TextEdit', typing: null, private: false } } }),
      ev('approval:asked', n * 10 + 1, { approvalId: `approval-${n}`, sessionId, tool: 'screen_act', callId: `call-${n}` }),
      ev('approval:answered', n * 10 + 2, { approvalId: `approval-${n}`, sessionId, tool: 'screen_act', answer: 'allowed-once', by: 'owner' }),
    ];
    const ladder = (sessionId: string) => [0, 1, 2].flatMap((n) => round(n, sessionId)).reduce((s, e) => autonomyTrack(approvalTrack(s, e).state, e).state, RIG).autonomy.ladder ?? [];
    expect(ladder('session-rig')).toEqual([]);
    expect(ladder('session-own')).toMatchObject([{ tool: 'screen_act', app: 'TextEdit', yes: 3 }]);
  });
});
