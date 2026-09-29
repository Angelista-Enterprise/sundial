import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { applyWorldHygiene, planHygiene, type HygieneEntity, type HygieneFact } from './world-hygiene.js';
import { contradictionCheck } from './contradiction-check.js';
import type { FactCandidate } from './entity-extract.js';

const ctx = { ownerAliases: ['pat'], projectNames: ['sundial', 'Gnomon'] };
const fact = (over: Partial<HygieneFact>): HygieneFact => ({ id: 'f', entityId: 'e', predicate: 'relatesToProject', object: 'sundial', confidence: 50, provenance: 'inference', createdAt: '2026-09-01T00:00:00.000Z', sourceType: null, ...over });
const ops = (plan: ReturnType<typeof planHygiene>) => plan.map((a) => (a.op === 'retract' ? `retract ${a.factId}` : `merge ${a.from}>${a.into}`));

describe('world hygiene (W2)', () => {
  it('retracts what a retired producer wrote, never an assertion', () => {
    const entities: HygieneEntity[] = [{ id: 'topic:max-zoom', kind: 'topic', canonicalName: 'MAX_ZOOM' }];
    const plan = planHygiene(entities, [fact({ id: 'a', entityId: 'topic:max-zoom', sourceType: 'symbol' }), fact({ id: 'b', entityId: 'topic:max-zoom', sourceType: 'symbol', provenance: 'assertion' })], ctx);
    expect(ops(plan)).toEqual(['retract a']);
  });

  it('keeps the NEWER of two values of a one-value fact — the four twice-recorded goals', () => {
    // The first live pass merged each pair before this rule existed and left a
    // goal holding "done" and "dropped" at once. The owner's later tap wins.
    const entities: HygieneEntity[] = [{ id: 'goal:ask-team', kind: 'goal', canonicalName: 'Ask team' }];
    const plan = planHygiene(
      entities,
      [
        fact({ id: 'old', entityId: 'goal:ask-team', predicate: 'status', object: 'done', provenance: 'assertion', createdAt: '2026-09-10T08:07:00.000Z' }),
        fact({ id: 'new', entityId: 'goal:ask-team', predicate: 'status', object: 'dropped', provenance: 'assertion', createdAt: '2026-09-11T10:47:00.000Z' }),
      ],
      ctx,
    );
    expect(ops(plan)).toEqual(['retract old']);
  });

  it('does not let a merge carry a stale one-value fact across, whichever side is newer', () => {
    const entities: HygieneEntity[] = [
      { id: 'goal:Ask team', kind: 'goal', canonicalName: 'Ask team' },
      { id: 'goal:ask-team', kind: 'goal', canonicalName: 'Ask team' },
    ];
    const plan = planHygiene(
      entities,
      [
        fact({ id: 'slug', entityId: 'goal:ask-team', predicate: 'status', object: 'done', provenance: 'assertion', createdAt: '2026-09-10T00:00:00.000Z' }),
        fact({ id: 'raw', entityId: 'goal:Ask team', predicate: 'status', object: 'dropped', provenance: 'assertion', createdAt: '2026-09-11T00:00:00.000Z' }),
      ],
      ctx,
    );
    expect(ops(plan)).toEqual(['retract slug', 'merge goal:Ask team>goal:ask-team']);
  });

  it('moves the owner out of another kind, dropping only what the owner has since corrected', () => {
    const entities: HygieneEntity[] = [
      { id: 'owner:pat', kind: 'owner', canonicalName: 'pat' },
      { id: 'topic:pat', kind: 'topic', canonicalName: 'Pat' },
    ];
    const plan = planHygiene(
      entities,
      [
        fact({ id: 'now', entityId: 'owner:pat', predicate: 'asleepBy', object: 'no fixed bedtime', provenance: 'assertion', createdAt: '2026-09-12T00:00:00.000Z' }),
        fact({ id: 'aug', entityId: 'topic:pat', predicate: 'asleepBy', object: '~22:00', provenance: 'assertion', createdAt: '2026-08-16T00:00:00.000Z' }),
        fact({ id: 'hotel', entityId: 'topic:pat', predicate: 'stayingAt', object: 'Elite Hotel', provenance: 'assertion', createdAt: '2026-08-18T00:00:00.000Z' }),
      ],
      ctx,
    );
    expect(ops(plan), 'the stale bedtime goes; the rest moves with the merge').toEqual(['retract aug', 'merge topic:pat>owner:pat']);
  });

  it('drops a self-alias and a word-for-word duplicate, and plans nothing on a clean record', () => {
    const entities: HygieneEntity[] = [{ id: 'person:aron', kind: 'person', canonicalName: 'Alex' }];
    const plan = planHygiene(
      entities,
      [
        fact({ id: 'self', entityId: 'person:aron', predicate: 'knownAs', object: 'Alex', provenance: 'assertion' }),
        fact({ id: 'm1', entityId: 'person:aron', predicate: 'attendedMeetingWith', object: 'owner', confidence: 60 }),
        fact({ id: 'm2', entityId: 'person:aron', predicate: 'attendedMeetingWith', object: 'owner', confidence: 59 }),
      ],
      ctx,
    );
    expect(ops(plan)).toEqual(['retract self', 'retract m2']);
    expect(planHygiene(entities, [fact({ id: 'm1', entityId: 'person:aron', predicate: 'attendedMeetingWith', object: 'owner' })], ctx)).toEqual([]);
  });

  it("merges a person the owner named as another existing one, and only on the owner's word (W5)", () => {
    const entities: HygieneEntity[] = [
      { id: 'person:alexm', kind: 'person', canonicalName: 'Alexm' },
      { id: 'person:alex-morgan', kind: 'person', canonicalName: 'Alex Morgan' },
      { id: 'person:tomas', kind: 'person', canonicalName: 'Noah' },
      { id: 'person:thomas', kind: 'person', canonicalName: 'Thomas' },
      { id: 'person:person-5f37', kind: 'person', canonicalName: 'person-5f37' },
    ];
    const plan = planHygiene(
      entities,
      [
        fact({ id: 'owner', entityId: 'person:alexm', predicate: 'knownAs', object: 'Alex Morgan', provenance: 'assertion' }),
        fact({ id: 'chat', entityId: 'person:tomas', predicate: 'knownAs', object: 'Thomas', provenance: 'conversation' }),
        fact({ id: 'hash', entityId: 'person:person-5f37', predicate: 'knownAs', object: 'Erik Vink', provenance: 'assertion' }),
      ],
      ctx,
    );
    expect(ops(plan), 'a conversation suggests, a name with no entity has nothing to merge into').toEqual(['retract owner', 'merge person:alexm>person:alex-morgan']);
  });

  it('M1: retires project usesTool that is OS plumbing or under three in-project sessions, never an assertion', () => {
    const entities: HygieneEntity[] = [{ id: 'project:sundial', kind: 'project', canonicalName: 'sundial' }];
    const tool = (id: string, object: string, provenance = 'inference') => fact({ id, entityId: 'project:sundial', predicate: 'usesTool', object, provenance });
    const sessions: Record<string, number> = { Code: 40, Warp: 2, Slack: 3 };
    const plan = planHygiene(
      entities,
      [tool('finder', 'Finder'), tool('code', 'Code'), tool('warp', 'Warp'), tool('slack', 'Slack'), tool('marked', '\u200ECode'), tool('said', 'Warp', 'assertion')],
      ctx,
      { toolSessionsInProject: (_e, t) => sessions[t] ?? 0 },
    );
    // The marked twin is the same app, so it goes as a duplicate of `code`.
    expect(ops(plan)).toEqual(['retract finder', 'retract warp', 'retract marked']);
    // Without the counts, only the plumbing rule applies.
    expect(ops(planHygiene(entities, [tool('warp', 'Warp'), tool('finder', 'System Settings')], ctx))).toEqual(['retract finder']);
  });

  it('M2: retires a fact the owner last marked wrong, assertion or not', () => {
    const entities: HygieneEntity[] = [{ id: 'person:mira-bakker', kind: 'person', canonicalName: 'Mira Bakker' }];
    const plan = planHygiene(
      entities,
      [fact({ id: 'w', entityId: 'person:mira-bakker', predicate: 'worksAt', object: 'puzzlebox-studio', provenance: 'assertion' }), fact({ id: 'ok', entityId: 'person:mira-bakker', predicate: 'role', object: 'designer' })],
      ctx,
      { wrongFactIds: new Set(['w', 'gone']) },
    );
    expect(ops(plan)).toEqual(['retract w']);
  });

  it('M1: a usesTool fact younger than seven days is not judged thin yet', () => {
    const entities: HygieneEntity[] = [{ id: 'project:sundial', kind: 'project', canonicalName: 'sundial' }];
    const young = fact({ id: 'young', entityId: 'project:sundial', predicate: 'usesTool', object: 'Warp', createdAt: '2026-09-25T00:00:00.000Z' });
    const old = fact({ id: 'old', entityId: 'project:sundial', predicate: 'usesTool', object: 'Slack', createdAt: '2026-09-01T00:00:00.000Z' });
    const plan = planHygiene(entities, [young, old], ctx, { toolSessionsInProject: () => 1, now: '2026-09-28T00:00:00.000Z' });
    expect(ops(plan)).toEqual(['retract old']);
  });

  it('a hygiene retraction clears the fact cursor, so later observations re-promote', () => {
    const candidate: FactCandidate = { entityId: 'project:sundial', entityKind: 'project', canonicalName: 'sundial', predicate: 'primaryTool', object: 'Code', confidence: 70, sourceEventId: 's', projectId: null, provenance: 'inference' };
    const observe = (state: ReturnType<typeof createInitialState>, n: number) => {
      const ev: SanitizedEvent = { id: `e${n}`, type: 'entity:fact-candidate', ts: `2026-09-0${n}T10:00:00.000Z`, payload: candidate as unknown as Record<string, unknown>, sanitized: true };
      return contradictionCheck(state, ev);
    };
    let state = createInitialState('d1');
    for (let n = 1; n <= 5; n++) state = observe(state, n).state;
    const factId = state.memory.factCursor['project:sundial:primaryTool'].factId!;
    expect(factId).not.toBeNull();

    const hygiene: SanitizedEvent = { id: 'h', type: 'world:hygiene', ts: '2026-09-06T00:00:00.000Z', payload: { actions: [{ op: 'retract', factId, reason: 'test' }] }, sanitized: true };
    state = applyWorldHygiene(state, hygiene).state;
    expect(state.memory.factCursor['project:sundial:primaryTool']).toMatchObject({ object: null, factId: null });

    const effects = [6, 7, 8, 9].flatMap((n) => {
      const r = observe(state, n);
      state = r.state;
      return r.effects as Array<{ type: string; factId?: string }>;
    });
    expect(effects.some((e) => e.type === 'UpsertEntityFact' && e.factId !== factId)).toBe(true);
    expect(effects.some((e) => e.type === 'ReinforceFact' && e.factId === factId), 'the retracted row is never reinforced').toBe(false);
  });
});
