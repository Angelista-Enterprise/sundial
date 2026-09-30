import { describe, it, expect } from 'vitest';
import { effectDeliveryGuarantee } from './effect-delivery.js';
import type { Effect } from './types.js';

/**
 * A representative of every variant in the `Effect` union. The point is not the
 * field values — it is that this list has to be extended when the union grows,
 * which is the same pressure the exhaustive `switch` applies to the
 * implementation.
 */
const EVERY_VARIANT: Effect[] = [
  { type: 'WriteDB', table: 'projects', row: { id: '/p', name: 'p', rootPath: '/p', organizationId: null } },
  { type: 'EmitEvent', event: { id: 'e', type: 'idle:start', ts: '2026-01-01T00:00:00.000Z', payload: {} } },
  { type: 'ScheduleLLM', purpose: 'companion', momentId: null, delayMs: 0, messages: [] },
  { type: 'UpdateMomentData', momentId: 'm', patch: {} },
  { type: 'Notify', channel: 'test', payload: {} },
  { type: 'DeleteRows', olderThan: '2026-01-01T00:00:00.000Z' },
  { type: 'UpsertEntityFact', factId: 'f', entityId: 'person:a', entityKind: 'person', canonicalName: 'A', predicate: 'p', object: 'o', confidence: 50, provenance: 'inference', sourceEventId: 'e1', ts: '2026-01-01T00:00:00.000Z' },
  { type: 'SupersedeFact', factId: 'f', supersededByFactId: 'g', ts: '2026-01-01T00:00:00.000Z' },
  { type: 'ReinforceFact', factId: 'f', delta: 1, ts: '2026-01-01T00:00:00.000Z' },
  { type: 'DecayFactConfidence', factor: 0.95, ts: '2026-01-01T00:00:00.000Z' },
  { type: 'DecayScores', factor: 0.95 },
  { type: 'Embed', id: 'x', refType: 'moment', refId: 'm', text: 't' },
  { type: 'RunReflection', since: '2026-01-01T00:00:00.000Z', ts: '2026-01-01T00:00:00.000Z' },
  { type: 'RunFactExtraction', since: '2026-01-01T00:00:00.000Z', ts: '2026-01-01T00:00:00.000Z' },
  { type: 'RunJournal', date: '2026-01-01', ts: '2026-01-01T00:00:00.000Z' },
];

describe('effectDeliveryGuarantee', () => {
  it('classifies every variant of the Effect union', () => {
    for (const effect of EVERY_VARIANT) {
      expect(['at-least-once', 'at-most-once']).toContain(effectDeliveryGuarantee(effect));
    }
  });

  /**
   * The current, deliberate state of the world: nothing leaves the machine
   * irreversibly, so nothing needs at-most-once delivery. This test is here to
   * FAIL when that changes — an effect becoming `at-most-once` is exactly the
   * moment someone should be made to read `effect-delivery.ts`'s doc comment and
   * the executor's `replayDecision`, rather than discovering the interaction
   * later from a duplicated outward action.
   */
  it('classifies every effect that exists today as at-least-once', () => {
    for (const effect of EVERY_VARIANT) {
      expect(effectDeliveryGuarantee(effect), `${effect.type} changed guarantee`).toBe('at-least-once');
    }
  });

  it('agrees with itself across the WriteDB tables, which share one variant', () => {
    const asks: Effect = { type: 'WriteDB', table: 'owner_asks', row: { id: 'owner-ask:1', question: 'q', reason: null, askedAt: '2026-01-01', answer: null, answeredAt: null, outcome: 'expired' } };
    expect(effectDeliveryGuarantee(asks)).toBe('at-least-once');
  });

  /**
   * The compile-time exhaustiveness check is the real guard, but it only fires
   * for code that type-checks against the current union. This covers the runtime
   * backstop behind it, and specifically that it fails SAFE: an effect whose
   * reversibility is unknown must not be retried after a crash. A backstop
   * returning `at-least-once` would be the convenient choice and would hand a
   * mystery effect exactly the wrong guarantee.
   */
  it('treats an unrecognised effect as at-most-once rather than retrying it', () => {
    const mystery = { type: 'SomethingNobodyClassified' } as unknown as Effect;
    expect(effectDeliveryGuarantee(mystery)).toBe('at-most-once');
  });
});
