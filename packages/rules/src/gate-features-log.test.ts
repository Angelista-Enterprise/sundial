import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, SanitizedEvent } from '@sundial/kernel/types.js';
import { applyGateFeatures, gateFeaturesJudge } from './gate-features-log.js';
import { gateDecisionId, noticeGate } from './notice-gate.js';

const TS = '2026-09-22T10:10:22.146Z';
const candidate: SanitizedEvent = {
  id: 'e-cand',
  type: 'notice:candidate',
  ts: TS,
  payload: { shape: 'transition', kind: 'commitment-quiet', key: 'commitment-quiet:commitment:crossword-zoom-fix', surprise: 1.0, precision: 1, concerns: [], valueHalfLifeMs: null, observation: 'crossword-zoom-fix has been quiet 14 days, after 2 days of work across 68 sessions', evidence: ['branch feature/crossword-zoom-fix', '2 active days', 'last touched 2026-09-08'] },
  sanitized: true,
};

describe('gateFeaturesJudge (J1.6)', () => {
  it('puts the candidate to the judge as the owner would see it, keyed to the decision row the gate writes on the same event', () => {
    const state = createInitialState('d1');
    const { effects } = gateFeaturesJudge(state, candidate);
    const judge = effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(judge).toMatchObject({ purpose: 'classify', questionSetId: 'gate-features', delayMs: 0 });
    expect(judge.state).toMatchObject({ notice: { title: 'crossword-zoom-fix has been quiet 14 days, after 2 days of work across 68 sessions', body: 'branch feature/crossword-zoom-fix; 2 active days; last touched 2026-09-08' } });
    // No gate arithmetic in the state: Jev judged numbers when it was given them.
    expect(JSON.stringify(judge.state)).not.toContain('surprise');
    const decision = noticeGate(state, candidate).effects.find((e) => e.type === 'RecordGateDecision') as Extract<Effect, { type: 'RecordGateDecision' }> | undefined;
    expect(judge.metadata).toEqual({ decisionId: gateDecisionId(TS, 'e-cand', 'commitment-quiet:commitment:crossword-zoom-fix'), noticeKey: 'commitment-quiet:commitment:crossword-zoom-fix', artifactId: 'commitment-quiet:commitment:crossword-zoom-fix' });
    if (decision) expect(decision.id).toBe(judge.metadata?.decisionId);
  });

  it('ignores a candidate with no key or no observation', () => {
    const state = createInitialState('d1');
    expect(gateFeaturesJudge(state, { ...candidate, payload: { key: 'k' } }).effects).toEqual([]);
    expect(gateFeaturesJudge(state, { ...candidate, type: 'clock:tick' }).effects).toEqual([]);
  });
});

describe('applyGateFeatures', () => {
  it('files the features as numbers beside the decision, and nothing else', () => {
    const result: SanitizedEvent = {
      id: 'e-jr',
      type: 'judgement:result',
      ts: '2026-09-22T10:10:22.500Z',
      payload: {
        purpose: 'classify',
        questionSetId: 'gate-features',
        momentId: null,
        model: 'typesafe/jev-latest',
        latencyMs: 268,
        metadata: { decisionId: 'dec-1', noticeKey: 'k' },
        answers: {
          speak_now: { type: 'noul', noul: 0.16 },
          value: { type: 'score', score: 1.39, probabilities: { '1': 0.6, '2': 0.4 } },
          channel: { type: 'choice', choice: 'ambient', probabilities: { silent: 0.1, ambient: 0.8, alert: 0.1 } },
          stale_soon: { type: 'noul', noul: 0.37 },
          actionable: { type: 'noul', noul: 0.55 },
        },
      },
      sanitized: true,
    };
    const before = createInitialState('d1');
    const { state, effects } = applyGateFeatures(before, result);
    expect(state).toBe(before);
    expect(effects).toEqual([
      { type: 'RecordGateFeatures', decisionId: 'dec-1', noticeKey: 'k', features: { speak_now: 0.16, value: 1, value_p: 0.6, channel: 'ambient', channel_p: 0.8, stale_soon: 0.37, actionable: 0.55, model: 'typesafe/jev-latest', at: '2026-09-22T10:10:22.500Z' } },
    ]);
    expect(applyGateFeatures(createInitialState('d1'), { ...result, payload: { ...result.payload, questionSetId: 'judge-line' } }).effects).toEqual([]);
  });
});
