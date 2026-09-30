import { describe, expect, it } from 'vitest';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_SAID, MAX_SESSIONS, MAX_TURNS, conversationTrack, mentioned } from './conversation-track.js';

let n = 0;
const ev = (type: string, payload: Record<string, unknown>, ts = '2026-09-29T12:02:10.000Z'): SanitizedEvent => ({ id: `e${++n}`, type, ts, payload, sanitized: true });
const fold = (state: KernelState, events: SanitizedEvent[]) => events.reduce((s, e) => conversationTrack(s, e).state, state);

const FACTS = [
  { key: 'git.unpushed', value: { total: 263, repos: [{ cwd: '~/Projects/acme/puzzlebox-studio', ahead: 263 }], since: '2026-09-29T11:00:00.000Z' } },
  { key: 'now.app', value: { app: 'Code', name: 'puzzlebox-studio', min: 7 } },
  { key: 'agents.idle', value: { total: 2, working: 1, idle: [{ name: 'Mira Bakker', state: 'question', min: 48 }] } },
];
const shown = (sessionId = 'session-7f') => ev('chat:shown', { sessionId, briefId: 'b1', cause: { kind: 'owner', noticeKey: null, askId: null }, v: 1, facts: FACTS, hints: {} });

describe('mentioned', () => {
  it('matches two-digit numbers as whole words and names of four or more characters, case-insensitively', () => {
    expect(mentioned(FACTS, 'You have 263 commits not pushed.')).toEqual([{ key: 'git.unpushed', value: 263 }]);
    expect(mentioned(FACTS, 'Still on Puzzlebox-Studio, and mira bakker asked something 48 min ago.')).toEqual([
      { key: 'now.app', value: 'puzzlebox-studio' },
      { key: 'agents.idle', value: 'Mira Bakker' },
      { key: 'agents.idle', value: 48 },
    ]);
    // Parts of a bigger number, a one-digit number, a cwd and an app name are not mentions.
    expect(mentioned(FACTS, 'That is 1,263 or 2630 or 7 lines in ~/Projects/acme and Code.')).toEqual([]);
  });
});

describe('conversationTrack', () => {
  it('binds the reply to the brief it was written against and records what it repeated', () => {
    const s = fold(createInitialState('d'), [shown(), ev('chat:owner', { sessionId: 'session-7f', turnId: 't1', text: 'anything I forgot?', chars: 18, images: 0 }), ev('chat:said', { sessionId: 'session-7f', turnId: 't1', text: '263 commits not pushed yet on puzzlebox-studio.', chars: 47, tools: [] })]);
    const session = s.conversation.sessions['session-7f'];
    expect(session.turns.map((t) => [t.by, t.shownId ?? null])).toEqual([['owner', null], ['gnomon', 'b1']]);
    expect(s.conversation.said).toEqual([
      { key: 'git.unpushed', value: 263, at: '2026-09-29T12:02:10.000Z', sessionId: 'session-7f', turnId: 't1' },
      { key: 'now.app', value: 'puzzlebox-studio', at: '2026-09-29T12:02:10.000Z', sessionId: 'session-7f', turnId: 't1' },
    ]);
  });

  it('keeps its bounds: twelve sessions, six turns each, fifty said', () => {
    let s = createInitialState('d');
    for (let i = 0; i < MAX_SESSIONS + 3; i++) s = fold(s, [ev('chat:owner', { sessionId: `s${i}`, turnId: `t${i}`, text: 'hello there' }, `2026-09-29T12:${String(i).padStart(2, '0')}:00.000Z`)]);
    expect(Object.keys(s.conversation.sessions)).toHaveLength(MAX_SESSIONS);
    expect(s.conversation.sessions.s0).toBeUndefined();
    for (let i = 0; i < 10; i++) s = fold(s, [ev('chat:owner', { sessionId: 's14', turnId: `u${i}`, text: 'x'.repeat(400) })]);
    expect(s.conversation.sessions.s14.turns).toHaveLength(MAX_TURNS);
    expect(s.conversation.sessions.s14.turns[0].text).toHaveLength(280);
    s = fold(s, [shown('s14')]);
    for (let i = 0; i < 30; i++) s = fold(s, [ev('chat:said', { sessionId: 's14', turnId: `v${i}`, text: '263 and 48' })]);
    expect(s.conversation.said).toHaveLength(MAX_SAID);
  });

  it('opens a promise the owner states, with the id the nightly pass would mint', () => {
    const { effects } = conversationTrack(createInitialState('d'), ev('chat:owner', { sessionId: 'session-7f', turnId: 't1', text: 'I promised Mira Bakker I will send the draft by Tuesday.' }));
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'EmitEvent', event: { type: 'commitment:heard', payload: { source: 'chat', direction: 'owner' } } });
  });

  it('forgets a deleted thread, and what was said in it', () => {
    let s = fold(createInitialState('d'), [shown(), ev('chat:said', { sessionId: 'session-7f', turnId: 't1', text: '263 commits' })]);
    const forget = ev('chat:forget', { sessionId: 'session-7f' });
    // W1 step 8: its rows go from the log and the ledger now, whether or not the fold still held it.
    expect(conversationTrack(s, forget).effects).toEqual([{ type: 'DeleteRows', olderThan: forget.ts, signalTypes: ['chat'], sessionId: 'session-7f' }]);
    s = fold(s, [forget]);
    expect(s.conversation).toEqual({ sessions: {}, said: [] });
    expect(conversationTrack(s, forget).effects).toHaveLength(1);
  });

  it('folds the same events to the same state twice, and ignores everything else', () => {
    const events = [shown(), ev('chat:owner', { sessionId: 'session-7f', turnId: 't1', text: 'status?' }), ev('chat:said', { sessionId: 'session-7f', turnId: 't1', text: '263 commits' })];
    const base = createInitialState('d');
    expect(fold(base, events)).toEqual(fold(base, events));
    expect(conversationTrack(base, ev('git:status', { cwd: '~/x', ahead: 0 })).state).toBe(base);
  });

  it('hydrates a snapshot written before the slice existed', () => {
    const old = { ...createInitialState('d') } as Record<string, unknown>;
    delete old.conversation;
    expect(hydrateSnapshot('d', old).conversation).toEqual({ sessions: {}, said: [] });
  });
});
