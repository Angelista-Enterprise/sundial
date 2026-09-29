import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { applyMomentJudgement, GOAL_ADVANCE_DEFAULT_THRESHOLD, inTheOwnersLanguage, PROMISE_RESOLVE_DEFAULT_THRESHOLD } from './apply-moment-judgement.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { GOAL_ADVANCE_QUESTIONS } from './questions/moment-fanout.js';

const result = (over: Record<string, unknown> = {}): SanitizedEvent => ({
  id: 'e1',
  type: 'judgement:result',
  ts: '2026-09-22T08:00:00.000Z',
  payload: {
    purpose: 'classify',
    questionSetId: 'moment-fanout',
    momentId: 'm-1',
    model: 'typesafe/jev-latest',
    latencyMs: 280,
    answers: {
      subject: { type: 'choice', choice: 'project', probabilities: { project: 0.7, app: 0.3 }, confidence: 0.7 },
      is_work: { type: 'noul', noul: 0.91 },
      depth: { type: 'score', score: 2.23, probabilities: { '1': 0.2, '2': 0.6, '3': 0.2 } },
      worth_remembering: { type: 'score', score: 1.4, probabilities: { '1': 0.55, '2': 0.45 } },
      contains_commitment: { type: 'noul', noul: 0.05 },
      contains_blocker: { type: 'noul', noul: 0.12 },
      interrupt_ok: { type: 'noul', noul: 0.4 },
    },
    ...over,
  },
  sanitized: true,
});

describe('applyMomentJudgement (J1.2, option A)', () => {
  it('stores the fan-out on the moment as levels and probabilities — numbers, no prose, no verdict', () => {
    const { state, effects } = applyMomentJudgement(createInitialState('d1'), result());
    expect(state).toBe(createInitialState('d1') && state);
    expect(effects).toEqual([
      {
        type: 'UpdateMomentData',
        momentId: 'm-1',
        patch: {
          judgement: {
            subject: 'project',
            subject_p: 0.7,
            is_work: 0.91,
            depth: 2,
            depth_p: 0.6,
            worth: 1,
            worth_p: 0.55,
            commitment: 0.05,
            blocker: 0.12,
            interrupt_ok: 0.4,
            model: 'typesafe/jev-latest',
            at: '2026-09-22T08:00:00.000Z',
          },
        },
      },
    ]);
  });

  it('ignores another set, a missing moment, and a partial answer set is stored as nulls', () => {
    const state = createInitialState('d1');
    expect(applyMomentJudgement(state, result({ questionSetId: 'judge-line' })).effects).toEqual([]);
    expect(applyMomentJudgement(state, result({ momentId: null })).effects).toEqual([]);
    const partial = applyMomentJudgement(state, result({ answers: { is_work: { type: 'noul', noul: 0.3 } } })).effects[0] as unknown as { patch: { judgement: Record<string, unknown> } };
    expect(partial.patch.judgement).toMatchObject({ is_work: 0.3, subject: null, depth: null, worth_p: null });
  });

  describe('J2.7 goal slots → goal:progress', () => {
    const withGoals = (g0: number, g1: number, over: Record<string, unknown> = {}) =>
      result({
        metadata: { durationMs: 25 * 60_000, goals: ['goal:a', 'goal:b'] },
        answers: { is_work: { type: 'noul', noul: 0.9 }, advances_goal_g0: { type: 'noul', noul: g0 }, advances_goal_g1: { type: 'noul', noul: g1 } },
        ...over,
      });

    it('credits the goal in the slot at or above the default operating point, with the moment\'s minutes', () => {
      const { effects } = applyMomentJudgement(createInitialState('d1'), withGoals(0.82, GOAL_ADVANCE_DEFAULT_THRESHOLD - 0.01));
      const emitted = effects.filter((e) => e.type === 'EmitEvent');
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as { event: { type: string; payload: unknown } }).event).toMatchObject({ type: 'goal:progress', payload: { goalId: 'goal:a', momentId: 'm-1', p: 0.82, minutes: 25 } });
    });

    it('no slot map in the metadata, no credit', () => {
      const { effects } = applyMomentJudgement(createInitialState('d1'), withGoals(0.95, 0.95, { metadata: { durationMs: 1000 } }));
      expect(effects.filter((e) => e.type === 'EmitEvent')).toHaveLength(0);
    });

    it('takes the slot\'s learned threshold only once it is learned (n ≥ 20)', () => {
      const id = questionId(GOAL_ADVANCE_QUESTIONS.advances_goal_g0);
      const base = createInitialState('d1');
      const record = { type: 'noul', threshold: 0.9, n: 0, hits: 0, bins: { n: Array(10).fill(0), hits: Array(10).fill(0) }, lastVerdictAt: null };
      const unlearned = { ...base, judgement: { ...base.judgement, questions: { [id]: record } } };
      expect(applyMomentJudgement(unlearned, withGoals(0.7, 0)).effects.filter((e) => e.type === 'EmitEvent')).toHaveLength(1);
      const learned = { ...base, judgement: { ...base.judgement, questions: { [id]: { ...record, n: THRESHOLD_MIN_N } } } };
      expect(applyMomentJudgement(learned, withGoals(0.7, 0)).effects.filter((e) => e.type === 'EmitEvent')).toHaveLength(0);
    });
  });

  describe('J4.4 commitments from speech', () => {
    const emitted = (effects: ReturnType<typeof applyMomentJudgement>['effects']) => effects.filter((e) => e.type === 'EmitEvent').map((e) => (e as { event: { type: string; payload: unknown } }).event);

    // A moment that started 2026-09-23 09:10 local (07:10Z), inside the standup.
    const STANDUP_MOMENT = '01M36HK4A0ABCDEFGHJKMNPQRS';
    const inStandup = () => {
      const s = createInitialState('d1');
      s.meetings = { seen: { 'Standup|2026-09-23T07:00:00.000Z': { title: 'Standup', start: '2026-09-23T07:00:00.000Z', end: '2026-09-23T07:30:00.000Z', attendees: ['team'], askedAt: null } } };
      return s;
    };
    const heard = (spoken: string, momentId = STANDUP_MOMENT) =>
      result({ momentId, metadata: { spoken, durationMs: 120_000, projectId: 'p1', projectName: 'puzzles' }, answers: { contains_commitment: { type: 'noul', noul: 0.9 } } });

    it('a moment\'s commitment noul opens nothing: the meeting pass (UC1) does, over the whole meeting', () => {
      expect(emitted(applyMomentJudgement(inStandup(), heard('Oké, dat is goed. Ik stuur het vanavond door naar Marco. Top.')).effects)).toHaveLength(0);
    });

    it('the words key still refuses the live noise of 2026-09-23', () => {
      for (const noise of ['Boom. But I\'ll Yo tengo un trato, bote. ¿Te acuerdas que falta un trato?', 'No. Hey, my hives. - Nice. وانك ويجريك I\'ve been going to back off.']) expect(inTheOwnersLanguage(noise)).toBe(false);
      expect(inTheOwnersLanguage('Ja, dan zit ik zo meteen even met Alex — café om 10:30?')).toBe(true);
    });

    it('a promise slot at θ closes THAT promise only with the second key (non-text evidence on the moment)', () => {
      const answers = { resolves_promise_p0: { type: 'noul', noul: 0.4 }, resolves_promise_p1: { type: 'noul', noul: PROMISE_RESOLVE_DEFAULT_THRESHOLD } };
      const withKey = emitted(applyMomentJudgement(createInitialState('d1'), result({ metadata: { promises: ['commitment:speech:a', 'commitment:speech:b'], nonText: true }, answers })).effects);
      expect(withKey).toHaveLength(1);
      expect(withKey[0]).toMatchObject({ type: 'commitment:resolved', payload: { id: 'commitment:speech:b', momentId: 'm-1', p: 0.7 } });
      expect(emitted(applyMomentJudgement(createInitialState('d1'), result({ metadata: { promises: ['commitment:speech:a', 'commitment:speech:b'], nonText: false }, answers })).effects)).toHaveLength(0);
    });
  });
});
