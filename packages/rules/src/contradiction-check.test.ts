import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { contradictionCheck, oneValueRepair, touchFactCursor } from './contradiction-check.js';
import type { FactCandidate } from './entity-extract.js';

function candidateEvent(candidate: FactCandidate, ts = '2026-01-01T10:00:00.000Z', id = 'e1'): SanitizedEvent {
  return { id, type: 'entity:fact-candidate', ts, payload: candidate as unknown as Record<string, unknown>, sanitized: true };
}

const BASE_CANDIDATE: FactCandidate = {
  entityId: 'project:gnomon',
  entityKind: 'project',
  canonicalName: 'gnomon',
  predicate: 'primaryTool',
  object: 'Code',
  confidence: 70,
  sourceEventId: 'src1',
  projectId: null,
  provenance: 'inference',
};

describe('contradictionCheck', () => {
  it('does not insert on the very first observation — starts a pending streak instead (D3 promotion policy)', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = contradictionCheck(state, candidateEvent(BASE_CANDIDATE));

    expect(effects).toEqual([]);
    expect(next.memory.factCursor['project:gnomon:primaryTool']).toEqual({ object: null, factId: null, confidence: 70, pendingObject: 'Code', pendingCount: 1, projectId: null });
    expect(next.memory.recentEntityIds).toEqual(['project:gnomon']);
  });

  it('C13: promotes a `task` candidate to an entity fact on the second observation — the tier is not allowlisted away', () => {
    const TASK: FactCandidate = {
      entityId: 'task:redesign-and-tablet',
      entityKind: 'task',
      canonicalName: 'redesign-and-tablet',
      predicate: 'relatesToProject',
      object: 'gnomon',
      confidence: 75,
      sourceEventId: 'src-task',
      projectId: '/repo/gnomon',
      provenance: 'inference',
    };
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(TASK, '2026-01-01T10:00:00.000Z', 'e1')).state; // first: pending only
    const { effects } = contradictionCheck(state, candidateEvent(TASK, '2026-01-01T11:00:00.000Z', 'e2'));
    const upsert = effects.find((e) => e.type === 'UpsertEntityFact');
    expect(upsert).toMatchObject({ type: 'UpsertEntityFact', entityKind: 'task', canonicalName: 'redesign-and-tablet', predicate: 'relatesToProject', object: 'gnomon' });
  });

  it('inserts (and embeds) a brand-new fact once the same candidate recurs across MIN_OBSERVATIONS_FOR_NEW_FACT distinct moments', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;

    const { state: next, effects } = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2'));

    expect(effects).toEqual([
      {
        type: 'UpsertEntityFact',
        factId: expect.any(String),
        entityId: 'project:gnomon',
        entityKind: 'project',
        canonicalName: 'gnomon',
        predicate: 'primaryTool',
        object: 'Code',
        confidence: 70,
        sourceEventId: 'src1',
        ts: '2026-01-01T11:00:00.000Z',
        provenance: 'inference',
      },
      { type: 'Embed', id: expect.any(String), refType: 'entity_fact', refId: expect.any(String), text: 'gnomon primaryTool Code' },
    ]);
    expect(next.memory.factCursor['project:gnomon:primaryTool']).toEqual({
      object: 'Code',
      factId: expect.any(String),
      confidence: 70,
      pendingObject: null,
      pendingCount: 0,
      projectId: null,
    });
  });

  it('reinforces a repeated observation of an already-confirmed fact (Phase 2a, D7)', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;
    const confirmedFactId = state.memory.factCursor['project:gnomon:primaryTool'].factId;
    expect(confirmedFactId).not.toBeNull();

    const { effects } = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T12:00:00.000Z', 'e3'));
    expect(effects).toEqual([{ type: 'ReinforceFact', factId: confirmedFactId, delta: 1, ts: '2026-01-01T12:00:00.000Z' }]);
  });

  it('treats a set-valued predicate (collaboratesOn) as coexisting — a second object does NOT supersede the first (Phase 2a, D9)', () => {
    let state = createInitialState('d1');
    const person = { entityId: 'person:priya', entityKind: 'person' as const, canonicalName: 'Priya', predicate: 'collaboratesOn', confidence: 60, sourceEventId: 's', projectId: null, provenance: 'inference' as const };
    const projA: FactCandidate = { ...person, object: 'gnomon' };
    const projB: FactCandidate = { ...person, object: 'vango' };

    // Promote 'gnomon' (needs 2 observations for a new fact).
    state = contradictionCheck(state, candidateEvent(projA, '2026-01-01T10:00:00.000Z', 'a1')).state;
    const promoteA = contradictionCheck(state, candidateEvent(projA, '2026-01-01T11:00:00.000Z', 'a2'));
    state = promoteA.state;
    expect(promoteA.effects.some((e) => e.type === 'UpsertEntityFact')).toBe(true);

    // A different object gets its OWN cursor key (set-valued) and its own pending streak — never a SupersedeFact.
    state = contradictionCheck(state, candidateEvent(projB, '2026-01-01T12:00:00.000Z', 'b1')).state;
    const promoteB = contradictionCheck(state, candidateEvent(projB, '2026-01-01T13:00:00.000Z', 'b2'));

    expect(promoteB.effects.some((e) => e.type === 'SupersedeFact')).toBe(false);
    expect(promoteB.effects.some((e) => e.type === 'UpsertEntityFact')).toBe(true);
    // Both objects coexist as separate cursor entries.
    expect(state.memory.factCursor['person:priya:collaboratesOn:gnomon'].object).toBe('gnomon');
    expect(promoteB.state.memory.factCursor['person:priya:collaboratesOn:vango'].object).toBe('vango');
  });

  it('does not supersede on a single conflicting observation — requires MIN_OBSERVATIONS_FOR_SUPERSESSION consecutive ones', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;
    const confirmedFactId = state.memory.factCursor['project:gnomon:primaryTool'].factId;

    const conflicting: FactCandidate = { ...BASE_CANDIDATE, object: 'Warp' };
    const { state: next, effects } = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T09:00:00.000Z', 'e3'));

    expect(effects).toEqual([]);
    expect(next.memory.factCursor['project:gnomon:primaryTool']).toEqual({ object: 'Code', factId: confirmedFactId, confidence: 70, pendingObject: 'Warp', pendingCount: 1, projectId: null });
  });

  it('supersedes the old fact and inserts (and embeds) a new one once the conflicting object recurs 3 consecutive times', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;
    const previousFactId = state.memory.factCursor['project:gnomon:primaryTool'].factId;

    const conflicting: FactCandidate = { ...BASE_CANDIDATE, object: 'Warp' };
    state = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T09:00:00.000Z', 'e3')).state;
    state = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T10:00:00.000Z', 'e4')).state;
    const { state: next, effects } = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T11:00:00.000Z', 'e5'));

    expect(effects).toEqual([
      { type: 'SupersedeFact', factId: previousFactId, supersededByFactId: expect.any(String), ts: '2026-01-02T11:00:00.000Z' },
      expect.objectContaining({ type: 'UpsertEntityFact', object: 'Warp' }),
      { type: 'Embed', id: expect.any(String), refType: 'entity_fact', refId: expect.any(String), text: 'gnomon primaryTool Warp' },
    ]);
    expect(next.memory.factCursor['project:gnomon:primaryTool'].object).toBe('Warp');
  });

  it('reverting to the confirmed value mid-contradiction resets the streak (a genuine "consecutive" requirement)', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;

    const conflicting: FactCandidate = { ...BASE_CANDIDATE, object: 'Warp' };
    state = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T09:00:00.000Z', 'e3')).state;
    state = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T10:00:00.000Z', 'e4')).state;
    // Reverts back to the confirmed value right before the streak would have completed.
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-02T11:00:00.000Z', 'e5')).state;
    expect(state.memory.factCursor['project:gnomon:primaryTool']).toMatchObject({ object: 'Code', pendingObject: null, pendingCount: 0 });

    // Two more conflicting observations should NOT be enough — the streak restarted, this is only the 2nd.
    state = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T12:00:00.000Z', 'e6')).state;
    const { effects } = contradictionCheck(state, candidateEvent(conflicting, '2026-01-02T13:00:00.000Z', 'e7'));
    expect(effects).toEqual([]);
  });

  it('a third, different pending value discards the prior pending streak rather than accumulating it', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    expect(state.memory.factCursor['project:gnomon:primaryTool']).toEqual({ object: null, factId: null, confidence: 70, pendingObject: 'Code', pendingCount: 1, projectId: null });

    const other: FactCandidate = { ...BASE_CANDIDATE, object: 'Warp' };
    state = contradictionCheck(state, candidateEvent(other, '2026-01-01T11:00:00.000Z', 'e2')).state;
    expect(state.memory.factCursor['project:gnomon:primaryTool']).toEqual({ object: null, factId: null, confidence: 70, pendingObject: 'Warp', pendingCount: 1, projectId: null });
  });

  it('caps recentEntityIds at 64 and moves a re-touched entity to the end', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 70; i++) {
      state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, entityId: `project:p${i}`, object: `tool${i}` }, '2026-01-01T10:00:00.000Z', `e${i}`)).state;
    }
    expect(state.memory.recentEntityIds).toHaveLength(64);
    expect(state.memory.recentEntityIds[63]).toBe('project:p69');
    expect(state.memory.recentEntityIds).not.toContain('project:p0');
  });

  it('caps factCursor at 512 entries (A§1.4), evicting the least recently touched key first', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 513; i++) {
      state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, entityId: `project:p${i}`, predicate: 'primaryTool', object: `tool${i}` }, '2026-01-01T10:00:00.000Z', `e${i}`)).state;
    }
    expect(Object.keys(state.memory.factCursor)).toHaveLength(512);
    expect(state.memory.factCursor['project:p512:primaryTool']).toBeDefined();
    expect(state.memory.factCursor['project:p0:primaryTool']).toBeUndefined();
  });

  it('touching an existing factCursor entry moves it to the front of the eviction order', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 512; i++) {
      state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, entityId: `project:p${i}`, predicate: 'primaryTool', object: `tool${i}` }, '2026-01-01T10:00:00.000Z', `e${i}`)).state;
    }
    // Re-observe the very first entry's pending value right before the map would otherwise evict it.
    state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, entityId: 'project:p0', predicate: 'primaryTool', object: 'tool0' }, '2026-01-01T11:00:00.000Z', 'e-touch')).state;
    state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, entityId: 'project:p512', predicate: 'primaryTool', object: 'tool512' }, '2026-01-01T10:00:00.000Z', 'e512')).state;

    expect(state.memory.factCursor['project:p0:primaryTool']).toBeDefined();
    expect(state.memory.factCursor['project:p1:primaryTool']).toBeUndefined();
  });

  it('is deterministic (A§1.2): replaying the same candidate event from the same starting state always mints the same factId', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    const event = candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2');

    const first = contradictionCheck(state, event).effects;
    const second = contradictionCheck(state, event).effects;

    expect((first[0] as { factId: string }).factId).toBe((second[0] as { factId: string }).factId);
  });

  it('carries the candidate\'s projectId onto the cursor entry, through pending and promotion (Working Memory per-project filtering)', () => {
    let state = createInitialState('d1');
    const scoped: FactCandidate = { ...BASE_CANDIDATE, entityId: 'topic:auth-refactor', canonicalName: 'auth refactor', predicate: 'relatesToProject', object: 'gnomon-base', projectId: 'project:gnomon-base' };

    state = contradictionCheck(state, candidateEvent(scoped, '2026-01-01T10:00:00.000Z', 'e1')).state;
    expect(state.memory.factCursor['topic:auth-refactor:relatesToProject:gnomon-base'].projectId).toBe('project:gnomon-base');

    state = contradictionCheck(state, candidateEvent(scoped, '2026-01-01T11:00:00.000Z', 'e2')).state;
    expect(state.memory.factCursor['topic:auth-refactor:relatesToProject:gnomon-base'].projectId).toBe('project:gnomon-base');
  });

  it('an assertion inserts on the very first observation — no corroboration wait, unlike an inference', () => {
    const state = createInitialState('d1');
    const assertion: FactCandidate = { ...BASE_CANDIDATE, provenance: 'assertion' };
    const { state: next, effects } = contradictionCheck(state, candidateEvent(assertion));

    expect(effects).toEqual([
      expect.objectContaining({ type: 'UpsertEntityFact', object: 'Code', provenance: 'assertion' }),
      expect.objectContaining({ type: 'Embed' }),
    ]);
    expect(next.memory.factCursor['project:gnomon:primaryTool']).toMatchObject({ object: 'Code', pendingObject: null, pendingCount: 0 });
  });

  it('an assertion supersedes a confirmed fact immediately, preserving the chain rather than requiring 3 consecutive contradictions', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;
    const previousFactId = state.memory.factCursor['project:gnomon:primaryTool'].factId;

    const correction: FactCandidate = { ...BASE_CANDIDATE, object: 'Warp', provenance: 'assertion' };
    const { state: next, effects } = contradictionCheck(state, candidateEvent(correction, '2026-01-02T09:00:00.000Z', 'e3'));

    expect(effects).toEqual([
      { type: 'SupersedeFact', factId: previousFactId, supersededByFactId: expect.any(String), ts: '2026-01-02T09:00:00.000Z' },
      expect.objectContaining({ type: 'UpsertEntityFact', object: 'Warp', provenance: 'assertion' }),
      expect.objectContaining({ type: 'Embed' }),
    ]);
    expect(next.memory.factCursor['project:gnomon:primaryTool'].object).toBe('Warp');
  });

  it('an assertion matching the already-confirmed value is just a reinforcement, same as an inference', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T11:00:00.000Z', 'e2')).state;
    const confirmedFactId = state.memory.factCursor['project:gnomon:primaryTool'].factId;

    const reaffirm: FactCandidate = { ...BASE_CANDIDATE, provenance: 'assertion' };
    const { effects } = contradictionCheck(state, candidateEvent(reaffirm, '2026-01-01T12:00:00.000Z', 'e3'));
    expect(effects).toEqual([{ type: 'ReinforceFact', factId: confirmedFactId, delta: 1, ts: '2026-01-01T12:00:00.000Z' }]);
  });

  it('treats a candidate with no provenance field (a pre-FactProvenance logged event, on replay) as an inference', () => {
    const state = createInitialState('d1');
    const legacyPayload: Record<string, unknown> = { ...BASE_CANDIDATE };
    delete legacyPayload.provenance;
    const event: SanitizedEvent = { id: 'e1', type: 'entity:fact-candidate', ts: '2026-01-01T10:00:00.000Z', payload: legacyPayload, sanitized: true };

    const { effects } = contradictionCheck(state, event);
    expect(effects).toEqual([]); // starts a pending streak, does not promote immediately
  });

  it('ignores non-entity:fact-candidate events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = contradictionCheck(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe('touchFactCursor eviction', () => {
  type Entry = { object: string | null; factId: string | null; confidence: number; pendingObject: string | null; pendingCount: number; projectId: string | null };
  const confirmed = (): Entry => ({ object: 'Code', factId: 'f1', confidence: 90, pendingObject: null, pendingCount: 0, projectId: null });
  const unconfirmed = (): Entry => ({ object: null, factId: null, confidence: 0, pendingObject: 'x', pendingCount: 1, projectId: null });

  it('evicts an unconfirmed entry before a confirmed one, even when the confirmed entry is the oldest', () => {
    const cursor: Record<string, Entry> = { 'confirmed:old': confirmed() };
    // Fill to the 512 cap with newer, unconfirmed entries.
    for (let i = 0; i < 511; i++) cursor[`unconf:${i}`] = unconfirmed();

    // Touching a new key overflows by one — the oldest UNCONFIRMED entry must
    // go, not the oldest (confirmed) one.
    const next = touchFactCursor(cursor, 'new:key', unconfirmed());

    expect(Object.keys(next)).toHaveLength(512);
    expect(next['confirmed:old']).toBeDefined();
    expect(next['unconf:0']).toBeUndefined();
    expect(next['new:key']).toBeDefined();
  });

  it('only reaches into confirmed entries once they alone exceed the cap', () => {
    const cursor: Record<string, Entry> = {};
    for (let i = 0; i < 512; i++) cursor[`c:${i}`] = confirmed();

    const next = touchFactCursor(cursor, 'c:new', confirmed());

    expect(Object.keys(next)).toHaveLength(512);
    expect(next['c:0']).toBeUndefined(); // oldest confirmed evicted — nothing unconfirmed to drop first
    expect(next['c:new']).toBeDefined();
  });
});

/**
 * The corroboration bar for `topic`, and the shape gate in front of it. Both
 * exist because the first full recompute (`scripts/recompute-derived.ts`) folded
 * historical candidate events through today's rules and promoted things nobody
 * wants in core memory — the shape gate covers malformed names, this covers
 * well-formed but thinly-evidenced ones.
 */
describe('contradictionCheck — topic corroboration bar', () => {
  const topic = (name: string): FactCandidate => ({
    entityId: `topic:${name.replace(/\s+/g, '-')}`,
    entityKind: 'topic',
    canonicalName: name,
    predicate: 'relatesToProject',
    object: 'gnomon',
    confidence: 40,
    sourceEventId: 'src1',
    projectId: null,
    provenance: 'inference',
  });

  function observe(times: number, candidate: FactCandidate) {
    let state = createInitialState('d1');
    for (let i = 0; i < times; i += 1) {
      state = contradictionCheck(state, candidateEvent(candidate, `2026-01-0${i + 1}T10:00:00.000Z`, `e${i}`)).state;
    }
    return state;
  }

  /**
   * The exact case that set the threshold: `toy story 5` was a repeated search
   * query, well-formed enough to pass the shape gate, and it cleared the old bar
   * of two. Two sightings of a passing curiosity is not a durable belief.
   */
  it('does not promote a topic seen twice, which the old bar of two would have', () => {
    const state = observe(2, topic('toy story 5'));
    expect(state.memory.factCursor['topic:toy-story-5:relatesToProject:gnomon']).toMatchObject({ object: null, pendingCount: 2 });
  });

  it('does not promote a topic seen three times either', () => {
    const state = observe(3, topic('toy story 5'));
    expect(state.memory.factCursor['topic:toy-story-5:relatesToProject:gnomon']).toMatchObject({ object: null, pendingCount: 3 });
  });

  /** "Keep them, but require more corroboration" — a genuinely recurring interest still lands. */
  it('promotes a topic on the fourth observation', () => {
    let state = observe(3, topic('ollama'));
    const { state: next, effects } = contradictionCheck(state, candidateEvent(topic('ollama'), '2026-01-05T10:00:00.000Z', 'e4'));
    state = next;

    expect(effects.some((e) => e.type === 'UpsertEntityFact')).toBe(true);
    expect(state.memory.factCursor['topic:ollama:relatesToProject:gnomon']).toMatchObject({ object: 'gnomon' });
  });

  it('leaves every other entity kind on the original bar of two', () => {
    const state = observe(2, { ...BASE_CANDIDATE });
    expect(state.memory.factCursor['project:gnomon:primaryTool']).toMatchObject({ object: 'Code' });
  });

  /**
   * The bar is on inference, not on the owner. An assertion promotes on one
   * observation regardless of kind (concepts/entity-facts-and-belief).
   */
  it('still promotes a topic asserted by the owner on one observation', () => {
    const state = createInitialState('d1');
    const { effects } = contradictionCheck(state, candidateEvent({ ...topic('mnema'), provenance: 'assertion' }));
    expect(effects.some((e) => e.type === 'UpsertEntityFact')).toBe(true);
  });
});

describe('contradictionCheck — malformed names never reach the cursor', () => {
  const malformed = (kind: FactCandidate['entityKind'], name: string): FactCandidate => ({
    ...BASE_CANDIDATE,
    entityId: `${kind}:x`,
    entityKind: kind,
    canonicalName: name,
  });

  it('drops a candidate whose name is punctuation, without touching state', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = contradictionCheck(state, candidateEvent(malformed('topic', ')')));

    expect(effects).toEqual([]);
    expect(next).toBe(state);
  });

  it('drops a window-title candidate', () => {
    const state = createInitialState('d1');
    const { state: next } = contradictionCheck(state, candidateEvent(malformed('topic', '] BE/FE: Paywall - JIRA (https://example.com/x)')));
    expect(next.memory.factCursor).toEqual({});
  });

  it('keeps a stable redaction alias proposed as a person — an unnamed invitee is still one person', () => {
    const state = createInitialState('d1');
    const { state: next } = contradictionCheck(state, candidateEvent(malformed('person', 'person-0a1b2c3d4e')));
    expect(Object.keys(next.memory.factCursor)).toHaveLength(1);
  });

  /**
   * Rejected BEFORE the cursor is touched, so a junk candidate cannot reset the
   * consecutive-observation streak of a legitimate pending value sharing its key.
   */
  it('does not break a legitimate pending streak', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(BASE_CANDIDATE, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = contradictionCheck(state, candidateEvent({ ...BASE_CANDIDATE, canonicalName: ')' }, '2026-01-02T10:00:00.000Z', 'e2')).state;

    expect(state.memory.factCursor['project:gnomon:primaryTool']).toMatchObject({ pendingObject: 'Code', pendingCount: 1 });
  });
});

describe('single-observation predicates (attendedMeetingWith)', () => {
  it('promotes a colleague on the first invite, without a second sighting', () => {
    const state = createInitialState('d1');
    const { effects } = contradictionCheck(state, candidateEvent({
      entityId: 'person:ben-de-groot',
      entityKind: 'person',
      canonicalName: 'Ben de Groot',
      predicate: 'attendedMeetingWith',
      object: 'owner',
      confidence: 60,
      sourceEventId: 'e1',
      projectId: null,
      provenance: 'inference',
    }));

    const upsert = effects.find((e: any) => e.type === 'UpsertEntityFact') as any;
    expect(upsert).toBeDefined();
    expect(upsert.entityKind).toBe('person');
    expect(upsert.predicate).toBe('attendedMeetingWith');
  });

  it('still requires two observations for an ordinary person predicate', () => {
    const state = createInitialState('d1');
    const { effects } = contradictionCheck(state, candidateEvent({
      entityId: 'person:someone',
      entityKind: 'person',
      canonicalName: 'Someone Else',
      predicate: 'collaboratesOn',
      object: 'overture',
      confidence: 60,
      sourceEventId: 'e1',
      projectId: null,
      provenance: 'inference',
    }));

    expect(effects.find((e: any) => e.type === 'UpsertEntityFact')).toBeUndefined();
  });

  it('does not lower the bar for superseding an already-confirmed fact', () => {
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent({
      entityId: 'person:bob', entityKind: 'person', canonicalName: 'Bob Jansen', predicate: 'attendedMeetingWith',
      object: 'owner', confidence: 60, sourceEventId: 'e1', projectId: null, provenance: 'inference',
    })).state;

    // A conflicting object on a confirmed fact still needs the full supersession streak.
    const conflicting = candidateEvent({
      entityId: 'person:bob', entityKind: 'person', canonicalName: 'Bob Jansen', predicate: 'attendedMeetingWith',
      object: 'someone-else', confidence: 60, sourceEventId: 'e2', projectId: null, provenance: 'inference',
    });
    const { effects } = contradictionCheck(state, conflicting);
    expect(effects.find((e: any) => e.type === 'SupersedeFact')).toBeUndefined();
  });
});

describe('lane Q (Q6)', () => {
  it('reinforces a confirmed fact at most once a local day, however often it is re-seen', () => {
    const tool: FactCandidate = { ...BASE_CANDIDATE, predicate: 'usesTool', object: 'Warp' };
    let state = createInitialState('d1');
    state.config.timezone = 'Europe/Amsterdam';
    state = contradictionCheck(state, candidateEvent(tool, '2026-09-28T08:00:00.000Z', 'a')).state;
    state = contradictionCheck(state, candidateEvent(tool, '2026-09-28T08:05:00.000Z', 'b')).state;
    const reinforced: string[] = [];
    for (const [i, ts] of ['2026-09-28T09:00:00.000Z', '2026-09-28T12:00:00.000Z', '2026-09-28T21:59:00.000Z', '2026-09-28T22:01:00.000Z', '2026-09-29T15:00:00.000Z'].entries()) {
      const out = contradictionCheck(state, candidateEvent(tool, ts, `r${i}`));
      state = out.state;
      if (out.effects.some((e) => e.type === 'ReinforceFact')) reinforced.push(ts);
    }
    // 22:01Z is past midnight in Amsterdam: a new local day.
    expect(reinforced).toEqual(['2026-09-28T09:00:00.000Z', '2026-09-28T22:01:00.000Z']);
  });

  it("a task's project is one value: a second project supersedes after three in a row, never sits beside it", () => {
    const task: FactCandidate = { ...BASE_CANDIDATE, entityId: 'task:box-484', entityKind: 'task', canonicalName: 'BOX-484', predicate: 'relatesToProject', object: 'puzzlebox-studio' };
    let state = createInitialState('d1');
    state = contradictionCheck(state, candidateEvent(task, '2026-09-28T08:00:00.000Z', 'a')).state;
    state = contradictionCheck(state, candidateEvent(task, '2026-09-28T08:05:00.000Z', 'b')).state;
    const first = state.memory.factCursor['task:box-484:relatesToProject']!.factId;
    const other = { ...task, object: 'sundial' };
    const effects = [];
    for (const [i, ts] of ['2026-09-28T09:00:00.000Z', '2026-09-28T09:05:00.000Z', '2026-09-28T09:10:00.000Z'].entries()) {
      const out = contradictionCheck(state, candidateEvent(other, ts, `o${i}`));
      state = out.state;
      effects.push(...out.effects);
    }
    expect(effects.map((e) => e.type)).toEqual(['SupersedeFact', 'UpsertEntityFact', 'Embed']);
    expect(effects[0]).toMatchObject({ factId: first });
    // A person's projects stay a set.
    expect(Object.keys(state.memory.factCursor).filter((k) => k.startsWith('task:'))).toEqual(['task:box-484:relatesToProject']);
  });
});

describe('oneValueRepair (Q6 boot repair)', () => {
  const fact = (id: string, entityId: string, object: string, alpha: number, validFrom: string) => ({ id, entityId, object, confidence: 80, alpha, validFrom });
  const facts = [
    fact('f1', 'task:box-484', 'puzzlebox-studio', 83.2, '2026-09-01T10:00:00.000Z'),
    fact('f2', 'task:box-484', 'sundial', 4.3, '2026-09-10T10:00:00.000Z'),
    fact('f3', 'task:box-484', 'lab', 18.8, '2026-09-12T10:00:00.000Z'),
    fact('f4', 'task:box-513', 'sundial', 9, '2026-09-02T10:00:00.000Z'),
    fact('f5', 'task:box-513', 'puzzlebox-studio', 9, '2026-09-20T10:00:00.000Z'),
    fact('f6', 'task:box-600', 'sundial', 5, '2026-09-03T10:00:00.000Z'),
  ];

  it('keeps the best-evidenced fact per task (then the newest), supersedes the rest by it, and points the cursor at it', () => {
    const s = createInitialState('d1');
    s.memory.factCursor = { 'task:box-484:relatesToProject:sundial': { object: 'sundial', factId: 'f2', confidence: 70, pendingObject: null, pendingCount: 0, projectId: null }, 'project:gnomon:primaryTool': { object: 'Code', factId: 'x', confidence: 70, pendingObject: null, pendingCount: 0, projectId: null } };
    const out = oneValueRepair(s, 'relatesToProject', facts, '2026-09-29T08:00:00.000Z');
    expect(out.effects).toEqual([
      { type: 'SupersedeFact', factId: 'f3', supersededByFactId: 'f1', ts: '2026-09-29T08:00:00.000Z' },
      { type: 'SupersedeFact', factId: 'f2', supersededByFactId: 'f1', ts: '2026-09-29T08:00:00.000Z' },
      { type: 'SupersedeFact', factId: 'f4', supersededByFactId: 'f5', ts: '2026-09-29T08:00:00.000Z' },
    ]);
    expect([out.superseded, out.entities]).toEqual([3, 2]);
    expect(Object.keys(out.state.memory.factCursor).sort()).toEqual(['project:gnomon:primaryTool', 'task:box-484:relatesToProject', 'task:box-513:relatesToProject', 'task:box-600:relatesToProject']);
    expect(out.state.memory.factCursor['task:box-484:relatesToProject']).toMatchObject({ object: 'puzzlebox-studio', factId: 'f1' });

    // A second boot: one fact per task, the slots in place — nothing to do.
    const kept = facts.filter((f) => ['f1', 'f5', 'f6'].includes(f.id));
    const again = oneValueRepair(out.state, 'relatesToProject', kept, '2026-09-29T09:00:00.000Z');
    expect([again.effects, again.state === out.state]).toEqual([[], true]);
  });
});
