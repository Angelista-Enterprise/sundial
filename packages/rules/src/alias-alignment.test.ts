import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_SUGGESTIONS, applyAliasAlignment, nightlyAliasAlignment, withSuggestion } from './alias-alignment.js';

const TS = '2026-09-23T00:00:00.000Z';
const ev = (type: string, payload: Record<string, unknown> = {}, ts = TS, id = 'e1'): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const known = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([root, name]) => [root, { name, org: null, remote: null, branch: null }]));
const merges = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent').map((e) => (e as Extract<Effect, { type: 'EmitEvent' }>).event.payload);

describe('nightlyAliasAlignment — the exact leg', () => {
  it('folds a synthetic named: root into its one real twin, lists two real roots with one name, and asks the judge', () => {
    const base = createInitialState('d1');
    const state: KernelState = {
      ...base,
      config: { ...base.config, projectAliases: { 'PB-Games': 'puzzlebox-studio' } },
      project: { ...base.project, known: known({ 'named:puzzlebox-studio': 'puzzlebox-studio', '~/acme/puzzlebox-studio': 'puzzlebox-studio', 'named:pb-games': 'PB-Games', '~/a/fb': 'familybudget-backend', '~/b/fb': 'familybudget-backend', '~/x/solo': 'solo' }) },
    };
    const { state: next, effects } = nightlyAliasAlignment(state, ev('day:boundary'));
    expect(merges(effects)).toEqual([
      { from: 'named:puzzlebox-studio', into: '~/acme/puzzlebox-studio' },
      { from: 'named:pb-games', into: '~/acme/puzzlebox-studio' },
    ]);
    expect(next.memory.aliasSuggestions).toEqual([expect.objectContaining({ kind: 'project', aId: '~/a/fb', bId: '~/b/fb', p: 1, basis: 'same-name' })]);
    expect(effects.at(-1)).toEqual({ type: 'RunAliasAlignment', ts: TS });
    expect(next.memory.lastAliasAlignmentAt).toBe(TS);
  });

  it('J2.4 open half: a hashed person whose knownAs names a person exactly is a MergeEntity; a name with no slug, or the hash itself, is not', () => {
    const base = createInitialState('d1');
    const state: KernelState = { ...base, memory: { ...base.memory, aliasNames: { 'person-e5a0c1d2b3': 'Eva', 'person-c205ca11f2': 'Alex Morgan', 'person-000000': '', tomas: 'Thomas' } } };
    const { effects } = nightlyAliasAlignment(state, ev('day:boundary'));
    expect(effects.filter((e) => e.type === 'MergeEntity')).toEqual([
      { type: 'MergeEntity', from: 'person:person-e5a0c1d2b3', into: 'person:eva', alias: 'person-e5a0c1d2b3', ts: TS },
      { type: 'MergeEntity', from: 'person:person-c205ca11f2', into: 'person:alex-morgan', alias: 'person-c205ca11f2', ts: TS },
    ]);
  });

  it('runs once on the first tick after shipping, then only on a boundary', () => {
    const base = createInitialState('d1');
    const first = nightlyAliasAlignment(base, ev('clock:tick'));
    expect(first.effects).toEqual([{ type: 'RunAliasAlignment', ts: TS }]);
    expect(nightlyAliasAlignment(first.state, ev('clock:tick', {}, '2026-09-23T00:01:00.000Z', 'e2')).effects).toEqual([]);
  });
});

describe('applyAliasAlignment — the judge leg', () => {
  const result = (p: number, meta = { kind: 'person', aId: 'person:tomas', a: 'Noah', bId: 'person:thomas', b: 'Thomas' }) =>
    ev('judgement:result', { purpose: 'audit', questionSetId: 'align-alias', momentId: null, answers: { same: { type: 'noul', noul: p } }, model: 'typesafe/jev-latest', latencyMs: 250, metadata: meta });

  it('files an answer at or above the threshold as a suggestion, upserting by pair, and drops one below', () => {
    const base = createInitialState('d1');
    const one = applyAliasAlignment(base, result(0.82)).state;
    expect(one.memory.aliasSuggestions).toEqual([{ kind: 'person', aId: 'person:tomas', a: 'Noah', bId: 'person:thomas', b: 'Thomas', p: 0.82, basis: 'judge', at: TS }]);
    const again = applyAliasAlignment(one, result(0.9, { kind: 'person', aId: 'person:thomas', a: 'Thomas', bId: 'person:tomas', b: 'Noah' })).state;
    expect(again.memory.aliasSuggestions).toHaveLength(1);
    expect(again.memory.aliasSuggestions[0].p).toBe(0.9);
    expect(applyAliasAlignment(base, result(0.3)).state.memory.aliasSuggestions).toEqual([]);
    expect(applyAliasAlignment(base, result(0.9)).effects).toEqual([]);
  });

  it('keeps the list bounded, highest p first', () => {
    let list: KernelState['memory']['aliasSuggestions'] = [];
    for (let i = 0; i < MAX_SUGGESTIONS + 5; i += 1) list = withSuggestion(list, { kind: 'project', aId: `a${i}`, a: `a${i}`, bId: `b${i}`, b: `b${i}`, p: (i % 10) / 10, basis: 'judge', at: TS });
    expect(list).toHaveLength(MAX_SUGGESTIONS);
    expect(list[0].p).toBeGreaterThanOrEqual(list.at(-1)!.p);
  });
});
