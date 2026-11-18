import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { ASKED_KEPT, CHATS_KEPT, privateReads } from './private-reads.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, s)).toISOString();
const row = (type: string, payload: Record<string, unknown>, s = 5): SanitizedEvent => ({ id: `${type}-${s}`, type, ts: at(s), payload }) as unknown as SanitizedEvent;
const decided = (verdict: string, facts: Record<string, unknown>, sessionId?: string) => row('action:decided', { tool: 'read', verdict, inputs: { facts }, ...(sessionId ? { sessionId } : {}) });
const looked = (more: Record<string, unknown> = {}) => row('screen:looked', { id: 'look-1', processName: 'Finder', windowTitle: 'notes', ...more });
const asked = (id: string, session: string) => row('screen:asked', { id, session }, 1);
const started = (sessionId?: string) => row('task:started', { ...(sessionId ? { sessionId } : {}), text: 'next' }, 9);
const fold = (events: SanitizedEvent[], state: KernelState = createInitialState('d')) => events.reduce((s, e) => privateReads(s, e).state, state);

describe('privateReads (Set 3 R3: per chat)', () => {
  it('a file read outside the workspace is filed under its chat; a refusal or a plain call reads nothing', () => {
    expect(fold([decided('allow', { reads: 'outside' }, 'chat-a')]).privateReads?.chats).toEqual({ 'chat-a': { at: at(5), kind: 'file' } });
    expect(fold([decided('ask', { reads: 'outside' })]).privateReads?.chats).toEqual({ '': { at: at(5), kind: 'file' } });
    const none = createInitialState('d');
    for (const e of [decided('deny', { reads: 'outside' }, 'chat-a'), decided('allow', {}, 'chat-a'), looked({ refused: 'private app' }), looked({ processName: '[hidden]' })]) expect(privateReads(none, e).state).toBe(none);
  });

  it('a look a chat asked for is that chat\'s, an act\'s after-look too; a look nobody asked for is every chat\'s', () => {
    expect(fold([asked('look-1', 'chat-a'), looked()]).privateReads?.chats).toEqual({ 'chat-a': { at: at(5), kind: 'screen' } });
    expect(fold([asked('act-7', 'chat-b'), looked({ id: 'look-9', after: 'act-7' })]).privateReads?.chats).toEqual({ 'chat-b': { at: at(5), kind: 'screen' } });
    expect(fold([asked('look-2', 'chat-a'), looked()]).privateReads?.chats).toEqual({ '': { at: at(5), kind: 'screen' } });
  });

  it('run 202: a read stays in force for its chat across its next requests; only a deleted chat (chat:forget) drops its entry', () => {
    const both = fold([decided('allow', { reads: 'outside' }, 'chat-a'), decided('allow', { reads: 'outside' }, 'chat-b'), looked()]);
    for (const e of [started('chat-a'), started('chat-b'), started()]) expect(privateReads(both, e).state, 'a new request in any chat').toBe(both);
    expect(Object.keys(fold([row('chat:forget', { sessionId: 'chat-a' }, 9)], both).privateReads?.chats ?? {})).toEqual(['chat-b', '']);
    expect(privateReads(both, row('chat:forget', { sessionId: 'chat-z' }, 9)).state).toBe(both);
    expect(privateReads(both, row('chat:forget', {}, 9)).state).toBe(both);
  });

  it('M4: a connected service\'s read and a read of the owner\'s record are filed by kind', () => {
    expect(fold([decided('allow', { reads: 'integration' }, 'chat-a')]).privateReads?.chats['chat-a']?.kind).toBe('integration');
    expect(fold([decided('allow', { reads: 'record' }, 'chat-a')]).privateReads?.chats['chat-a']?.kind).toBe('record');
    expect(fold([decided('allow', { reads: 'other' }, 'chat-a')]).privateReads).toBeUndefined();
  });

  it('keeps the newest chats and asked ids only', () => {
    const many = fold(Array.from({ length: CHATS_KEPT + 5 }, (_, i) => decided('allow', { reads: 'outside' }, `chat-${i}`)));
    expect(Object.keys(many.privateReads?.chats ?? {})).toHaveLength(CHATS_KEPT);
    expect(many.privateReads?.chats[`chat-${CHATS_KEPT + 4}`]).toBeDefined();
    const ids = fold(Array.from({ length: ASKED_KEPT + 5 }, (_, i) => asked(`look-${i}`, 'chat-a')));
    expect(Object.keys(ids.privateReads?.asked ?? {})).toHaveLength(ASKED_KEPT);
  });
});
