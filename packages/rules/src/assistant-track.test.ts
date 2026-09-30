import { describe, it, expect } from 'vitest';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { proposalsOf } from '@sundial/helpers/loops.js';
import { assistantTrack, assistantAcceptanceRate } from './assistant-track.js';
import { loopTrack } from './loop-track.js';
import { contradictionCheck } from './contradiction-check.js';

// W2 M2: a proposal is a loop `loopTrack` folds; `assistantTrack` counts it after, on the same event.
const fold = (state: KernelState, event: SanitizedEvent) => {
  const a = loopTrack(state, event);
  const b = assistantTrack(a.state, event);
  return { state: b.state, effects: [...a.effects, ...b.effects] };
};
const ev = (type: string, payload: Record<string, unknown>, ts = '2026-08-14T10:00:00.000Z', id = 'e1'): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });

describe('proposals, a loop kind (W2 M2), and their counts', () => {
  it('an old snapshot hydrates its proposals into loops once: open ones open, answered ones closed', () => {
    const recent = [{ id: 'prop-1', summary: 'Split the reducer', kind: 'refactor', outcome: 'accepted', at: '2026-08-14T09:00:00.000Z', resolvedAt: '2026-08-14T09:05:00.000Z' }, { id: 'prop-2', summary: 'Draft the BOX-484 reply', kind: 'answer', outcome: 'open', at: '2026-08-14T09:10:00.000Z', resolvedAt: null }];
    const state = hydrateSnapshot('d1', { assistant: { recent, proposedCount: 2, acceptedCount: 1, rejectedCount: 0, claimedCount: 0, lastAt: null } } as unknown as Partial<KernelState>);
    expect(proposalsOf(state)).toEqual(recent);
    expect('recent' in state.assistant).toBe(false);
    expect(state.loops.open.map((l) => l.subject)).toEqual(['prop-2']);
    expect(fold(state, ev('assistant:response', { verdict: 'rejected', proposalId: 'prop-2' })).state.assistant.rejectedCount).toBe(1);
  });

  it('past its week a proposal answers only to its own id, and the oldest of 41 open goes quietly', () => {
    let state = fold(createInitialState('d1'), ev('assistant:proposal', { proposalId: 'prop-9', summary: 'x' })).state;
    state = fold(state, ev('clock:tick', {}, '2026-08-21T10:00:01.000Z', 't')).state;
    expect(fold(state, ev('assistant:response', { verdict: 'accepted' }, '2026-08-21T10:01:00.000Z', 'e8')).state.assistant.acceptedCount).toBe(0);
    expect(fold(state, ev('assistant:response', { verdict: 'accepted', proposalId: 'prop-9' }, '2026-08-21T10:01:00.000Z', 'e9')).state.assistant.acceptedCount).toBe(1);
    for (let i = 0; i < 40; i += 1) state = fold(state, ev('assistant:proposal', { proposalId: `p${i}`, summary: 'y' }, '2026-08-22T10:00:00.000Z', `p${i}`)).state;
    expect(state.loops.open.map((l) => l.subject)).toEqual(Array.from({ length: 40 }, (_, i) => `p${i}`));
  });

  it('opens a proposal and counts it', () => {
    const { state, effects } = fold(createInitialState('d1'), ev('assistant:proposal', { summary: 'Split the reducer', kind: 'refactor' }));

    expect(effects).toEqual([]);
    expect(state.assistant.proposedCount).toBe(1);
    expect(proposalsOf(state)[0]).toMatchObject({ summary: 'Split the reducer', kind: 'refactor', outcome: 'open', resolvedAt: null });
  });

  it('closes the most recent open proposal when the response names no id', () => {
    let state = fold(createInitialState('d1'), ev('assistant:proposal', { summary: 'Split the reducer' })).state;
    state = fold(state, ev('assistant:response', { verdict: 'accepted' }, '2026-08-14T10:05:00.000Z', 'e2')).state;

    expect(state.assistant.acceptedCount).toBe(1);
    expect(proposalsOf(state)[0]!.outcome).toBe('accepted');
    expect(proposalsOf(state)[0]!.resolvedAt).toBe('2026-08-14T10:05:00.000Z');
  });

  it('W6 D3: the id minted at the proposal is the one its response names, so the two rows join in the log', () => {
    let state = fold(createInitialState('d1'), ev('assistant:proposal', { proposalId: 'prop-484', summary: 'Draft the BOX-484 reply' })).state;
    expect(proposalsOf(state)[0]!.id).toBe('prop-484');
    state = fold(state, ev('assistant:response', { verdict: 'rejected', proposalId: 'prop-484' }, '2026-08-14T10:05:00.000Z', 'e2')).state;
    expect(proposalsOf(state)[0]!.outcome).toBe('rejected');
    // A proposal from before the fix keeps its derived id (replay unchanged).
    expect(proposalsOf(fold(createInitialState('d1'), ev('assistant:proposal', { summary: 'x' })).state)[0]!.id).not.toBe('');
  });

  it('does not re-resolve an already-answered proposal', () => {
    let state = fold(createInitialState('d1'), ev('assistant:proposal', { summary: 'x' })).state;
    state = fold(state, ev('assistant:response', { verdict: 'accepted' }, '2026-08-14T10:05:00.000Z', 'e2')).state;
    const again = fold(state, ev('assistant:response', { verdict: 'rejected', proposalId: proposalsOf(state)[0]!.id }, '2026-08-14T10:06:00.000Z', 'e3'));

    expect(again.state.assistant.rejectedCount).toBe(0);
    expect(again.state.assistant.acceptedCount).toBe(1);
  });

  it('ignores a verdict that is neither accepted nor rejected', () => {
    const state = fold(createInitialState('d1'), ev('assistant:proposal', { summary: 'x' })).state;
    const { state: next } = fold(state, ev('assistant:response', { verdict: 'maybe' }, '2026-08-14T10:05:00.000Z', 'e2'));
    expect(proposalsOf(next)[0]!.outcome).toBe('open');
  });

  it('routes a claim through the ordinary candidate path with assistant provenance', () => {
    const { state, effects } = assistantTrack(
      createInitialState('d1'),
      ev('assistant:claim', { entityKind: 'project', canonicalName: 'Gnomon Base', predicate: 'usesTool', object: 'SQLite' }),
    );

    expect(state.assistant.claimedCount).toBe(1);
    expect(effects).toHaveLength(1);
    const inner = (effects[0] as any).event;
    expect(inner.type).toBe('entity:fact-candidate');
    expect(inner.payload).toMatchObject({ entityId: 'project:gnomon-base', predicate: 'usesTool', object: 'SQLite', provenance: 'assistant' });
    // Never an UpsertEntityFact: an assistant gets no privileged write to core memory.
    expect(effects.some((e: any) => e.type === 'UpsertEntityFact')).toBe(false);
  });

  it('gives an assistant claim NO shortcut past the promotion policy', () => {
    // The load-bearing test for decisions/assistant-as-an-event-source: an owner
    // assertion supersedes on one observation, an assistant claim must not.
    const claim = assistantTrack(createInitialState('d1'), ev('assistant:claim', { entityKind: 'project', canonicalName: 'gnomon', predicate: 'usesTool', object: 'SQLite' }));
    const candidate = (claim.effects[0] as any).event;

    const { effects } = contradictionCheck(claim.state, candidate);
    expect(effects.find((e: any) => e.type === 'UpsertEntityFact')).toBeUndefined();
  });

  it('clamps a self-assigned confidence below certainty', () => {
    const { effects } = assistantTrack(
      createInitialState('d1'),
      ev('assistant:claim', { entityKind: 'tool', canonicalName: 'ripgrep', predicate: 'usedFor', object: 'search', confidence: 100 }),
    );
    expect((effects[0] as any).event.payload.confidence).toBe(99);
  });

  it('rejects a malformed claim outright', () => {
    for (const payload of [{ entityKind: 'wizard', canonicalName: 'x', predicate: 'p', object: 'o' }, { entityKind: 'tool', canonicalName: '', predicate: 'p', object: 'o' }, { entityKind: 'tool', canonicalName: 'x', predicate: 'p' }]) {
      const { state, effects } = assistantTrack(createInitialState('d1'), ev('assistant:claim', payload));
      expect(effects).toEqual([]);
      expect(state.assistant.claimedCount).toBe(0);
    }
  });

  it('ignores unrelated events', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = assistantTrack(state, ev('window:changed', {}));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe('assistantAcceptanceRate', () => {
  it('refuses to report a rate from too few resolutions', () => {
    const state: KernelState = { ...createInitialState('d1'), assistant: { proposedCount: 3, acceptedCount: 2, rejectedCount: 1, claimedCount: 0, lastAt: null } };
    expect(assistantAcceptanceRate(state)).toBeNull();
  });

  it('reports once enough have resolved', () => {
    const state: KernelState = { ...createInitialState('d1'), assistant: { proposedCount: 12, acceptedCount: 9, rejectedCount: 3, claimedCount: 0, lastAt: null } };
    expect(assistantAcceptanceRate(state)).toBe(0.75);
  });
});
