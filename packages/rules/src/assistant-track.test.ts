import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { assistantTrack, assistantAcceptanceRate } from './assistant-track.js';
import { contradictionCheck } from './contradiction-check.js';

const ev = (type: string, payload: Record<string, unknown>, ts = '2026-08-14T10:00:00.000Z', id = 'e1'): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });

describe('assistantTrack', () => {
  it('opens a proposal and counts it', () => {
    const { state, effects } = assistantTrack(createInitialState('d1'), ev('assistant:proposal', { summary: 'Split the reducer', kind: 'refactor' }));

    expect(effects).toEqual([]);
    expect(state.assistant.proposedCount).toBe(1);
    expect(state.assistant.recent[0]).toMatchObject({ summary: 'Split the reducer', kind: 'refactor', outcome: 'open', resolvedAt: null });
  });

  it('closes the most recent open proposal when the response names no id', () => {
    let state = assistantTrack(createInitialState('d1'), ev('assistant:proposal', { summary: 'Split the reducer' })).state;
    state = assistantTrack(state, ev('assistant:response', { verdict: 'accepted' }, '2026-08-14T10:05:00.000Z', 'e2')).state;

    expect(state.assistant.acceptedCount).toBe(1);
    expect(state.assistant.recent[0]!.outcome).toBe('accepted');
    expect(state.assistant.recent[0]!.resolvedAt).toBe('2026-08-14T10:05:00.000Z');
  });

  it('does not re-resolve an already-answered proposal', () => {
    let state = assistantTrack(createInitialState('d1'), ev('assistant:proposal', { summary: 'x' })).state;
    state = assistantTrack(state, ev('assistant:response', { verdict: 'accepted' }, '2026-08-14T10:05:00.000Z', 'e2')).state;
    const again = assistantTrack(state, ev('assistant:response', { verdict: 'rejected', proposalId: state.assistant.recent[0]!.id }, '2026-08-14T10:06:00.000Z', 'e3'));

    expect(again.state.assistant.rejectedCount).toBe(0);
    expect(again.state.assistant.acceptedCount).toBe(1);
  });

  it('ignores a verdict that is neither accepted nor rejected', () => {
    const state = assistantTrack(createInitialState('d1'), ev('assistant:proposal', { summary: 'x' })).state;
    const { state: next } = assistantTrack(state, ev('assistant:response', { verdict: 'maybe' }, '2026-08-14T10:05:00.000Z', 'e2'));
    expect(next.assistant.recent[0]!.outcome).toBe('open');
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
    const state: KernelState = { ...createInitialState('d1'), assistant: { recent: [], proposedCount: 3, acceptedCount: 2, rejectedCount: 1, claimedCount: 0, lastAt: null } };
    expect(assistantAcceptanceRate(state)).toBeNull();
  });

  it('reports once enough have resolved', () => {
    const state: KernelState = { ...createInitialState('d1'), assistant: { recent: [], proposedCount: 12, acceptedCount: 9, rejectedCount: 3, claimedCount: 0, lastAt: null } };
    expect(assistantAcceptanceRate(state)).toBe(0.75);
  });
});
