import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { IS_FALSE, applyFactAudit, nightlyBeliefAudit } from './nightly-belief-audit.js';

const TS = '2026-09-22T22:00:00.000Z';
const ev = (type: string, payload: Record<string, unknown> = {}, ts = TS, id = 'e1'): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const retracts = (effects: Effect[]) => effects.filter((e) => e.type === 'RetractFact') as Extract<Effect, { type: 'RetractFact' }>[];
const result = (isFalse: number, provenance = 'inference', extra: Record<string, unknown> = {}) =>
  ev('judgement:result', {
    purpose: 'audit',
    questionSetId: 'audit-fact',
    momentId: null,
    answers: { is_false: { type: 'noul', noul: isFalse }, is_artifact: { type: 'noul', noul: 0.53 }, still_current: { type: 'noul', noul: 0.6 }, usefulness: { type: 'score', score: 1.0 } },
    model: 'typesafe/jev-latest',
    latencyMs: 300,
    metadata: { factId: 'fact-1', provenance, belief: 'Vergaderkamer 2.18 attendedMeetingWith owner' },
    ...extra,
  });

describe('nightlyBeliefAudit', () => {
  it('runs when the owner goes idle, at most once a day, and never on a clock', () => {
    const base = createInitialState('d1');
    expect(nightlyBeliefAudit(base, ev('clock:tick')).effects).toEqual([]);
    expect(nightlyBeliefAudit(base, ev('day:boundary')).effects).toEqual([]);
    const first = nightlyBeliefAudit(base, ev('idle:start'));
    expect(first.effects).toEqual([{ type: 'RunBeliefAudit', ts: TS }]);
    expect(first.state.memory.lastBeliefAuditAt).toBe(TS);
    expect(nightlyBeliefAudit(first.state, ev('idle:start', {}, '2026-09-23T10:00:00.000Z', 'e2')).effects).toEqual([]);
    const next = nightlyBeliefAudit(first.state, ev('idle:start', {}, '2026-09-23T18:30:00.000Z', 'e3'));
    expect(next.effects).toEqual([{ type: 'RunBeliefAudit', ts: '2026-09-23T18:30:00.000Z' }]);
  });
});

describe('applyFactAudit', () => {
  const base = createInitialState('d1');

  it('retracts at is_false ≥ 0.7 with the answers as the reason, and not below', () => {
    const hit = applyFactAudit(base, result(0.81));
    expect(retracts(hit.effects)).toEqual([{ type: 'RetractFact', factId: 'fact-1', reason: 'belief audit: is_false 0.81 · artifact 0.53 · still_current 0.60 · Vergaderkamer 2.18 attendedMeetingWith owner', ts: TS }]);
    expect(applyFactAudit(base, result(0.69)).effects).toEqual([]);
  });

  it('never retracts an assertion, and ignores other sets', () => {
    expect(applyFactAudit(base, result(0.95, 'assertion')).effects).toEqual([]);
    expect(applyFactAudit(base, result(0.95, 'inference', { questionSetId: 'moment-fanout' })).effects).toEqual([]);
  });

  it('reads the learned threshold for is_false when the owner’s verdicts have moved it', () => {
    const learned: KernelState = { ...base, judgement: { ...base.judgement, questions: { ...base.judgement.questions, [IS_FALSE]: { type: 'noul', threshold: 0.9, n: 25, hits: 20, bins: [] } as never } } };
    expect(applyFactAudit(learned, result(0.81)).effects).toEqual([]);
    expect(retracts(applyFactAudit(learned, result(0.92)).effects)).toHaveLength(1);
    // The registry default (0.5, n < 20) is NOT learned and must not lower the bar: the first live pass did exactly that.
    const unlearned: KernelState = { ...base, judgement: { ...base.judgement, questions: { ...base.judgement.questions, [IS_FALSE]: { type: 'noul', threshold: 0.5, n: 0, hits: 0, bins: [] } as never } } };
    expect(applyFactAudit(unlearned, result(0.55)).effects).toEqual([]);
    expect(retracts(applyFactAudit(unlearned, result(0.72)).effects)).toHaveLength(1);
  });
});
