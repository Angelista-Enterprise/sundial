import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { conversationTrack } from './conversation-track.js';
import { CORRECT_WITHIN_MS, selfCorrection } from './self-correction.js';

const T0 = Date.parse('2026-11-03T10:00:00.000Z'); // a Tuesday
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });
const FACT = { id: 'fact-7', predicate: 'worksAt', object: 'Puzzlebox Studio' };

/** A turn whose brief carried FACT, and a reply that cites it or not. Made-up values. */
function cited(reply = 'You work at Puzzlebox Studio, so the BOX tickets are yours.'): KernelState {
  let s: KernelState = { ...createInitialState('d1'), config: { ...createInitialState('d1').config, timezone: 'UTC', ownerAliases: ['Mira Bakker'] } };
  s = conversationTrack(s, ev('chat:shown', 0, { sessionId: 's1', briefId: 'b1', facts: [], cites: [FACT] })).state;
  return conversationTrack(s, ev('chat:said', 5, { sessionId: 's1', turnId: 't1', text: reply })).state;
}
const notices = (effects: Effect[]) => effects.flatMap((e) => (e.type === 'EmitEvent' && e.event.type === 'notice:candidate' ? [e.event.payload as Record<string, unknown>] : []));

describe('selfCorrection (plan 15 4.5)', () => {
  it('a reply that names a carried fact puts it on the cited ring; one that does not, does not', () => {
    expect(cited().conversation.cited).toEqual([{ ...FACT, at: at(5) }]);
    expect(cited('Nothing about work today.').conversation.cited).toBeUndefined();
  });

  it('the owner marks a cited fact wrong: one notice says so', () => {
    const out = selfCorrection(cited(), ev('feedback:verdict', 3600, { artifactKind: 'entity_fact', artifactId: 'fact-7', verdict: 'wrong' }));
    expect(notices(out.effects)).toMatchObject([{ kind: 'self-correction', key: 'self-correction:fact-7', observation: 'On Tuesday I said worksAt: Puzzlebox Studio. That was wrong.' }]);
  });

  it('the owner sets the same predicate right: the notice says what it is now', () => {
    const out = selfCorrection(cited(), ev('entity:fact-candidate', 3600, { provenance: 'assertion', canonicalName: 'Mira Bakker', predicate: 'worksAt', object: 'Orbit Labs' }));
    expect(notices(out.effects)[0]?.observation).toBe('On Tuesday I said worksAt: Puzzlebox Studio. That was wrong. It is Orbit Labs.');
    expect(selfCorrection(cited(), ev('entity:fact-candidate', 3600, { provenance: 'assertion', canonicalName: 'Mira Bakker', predicate: 'likes', object: 'tea' })).effects).toEqual([]);
  });

  it('nothing for a fact it never cited, another person, the same value, or after 14 days', () => {
    const s = cited();
    expect(selfCorrection(s, ev('feedback:verdict', 60, { artifactKind: 'entity_fact', artifactId: 'fact-9', verdict: 'wrong' })).effects).toEqual([]);
    expect(selfCorrection(s, ev('entity:fact-candidate', 60, { provenance: 'assertion', canonicalName: 'Jonas Vermeer', predicate: 'worksAt', object: 'Orbit Labs' })).effects).toEqual([]);
    expect(selfCorrection(s, ev('entity:fact-candidate', 60, { provenance: 'assertion', canonicalName: 'Mira Bakker', predicate: 'worksAt', object: 'puzzlebox studio' })).effects).toEqual([]);
    expect(selfCorrection(s, ev('feedback:verdict', CORRECT_WITHIN_MS / 1000 + 10, { artifactKind: 'entity_fact', artifactId: 'fact-7', verdict: 'wrong' })).effects).toEqual([]);
  });
});
