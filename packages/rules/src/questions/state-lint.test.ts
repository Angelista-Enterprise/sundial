import { describe, expect, it } from 'vitest';
import { QUESTION_SETS } from './registry.js';
import { lintState } from './state-lint.js';

describe('the ten laws of state, over every registry set (J0.6)', () => {
  for (const set of QUESTION_SETS) {
    it(`${set.id}: every sample builds a state with no violation`, () => {
      const samples = set.samples();
      expect(samples.length).toBeGreaterThan(0);
      for (const input of samples) {
        const { state, questions } = set.build(...input);
        expect(lintState(state)).toEqual([]);
        // Law 5/6 hygiene: every question is one of the three primitives with an instruction.
        for (const [id, q] of Object.entries(questions)) {
          expect(['choice', 'score', 'noul'], id).toContain(q.type);
          expect(q.instructions.length, id).toBeGreaterThan(10);
        }
      }
    });
  }

  it('fails on a planted violation of each law', () => {
    const planted = {
      minutes: 31,
      kind: 'focus', // law 2
      nested: { verdict: 'useful', label: 'x' }, // law 2, twice
      life_events: ['event:thrashing'], // law 7
      heard_aloud: 'y'.repeat(601), // law 8
      window_titles: Array.from({ length: 13 }, (_, i) => `t${i}`), // law 8
      counts: Array.from({ length: 20 }, (_, i) => i), // a list of NUMBERS is fine
    };
    const violations = lintState(planted);
    expect(violations.map((v) => `${v.law}:${v.path}`).sort()).toEqual(
      ['2:state.kind', '2:state.nested.label', '2:state.nested.verdict', '7:state.life_events', '8:state.heard_aloud', '8:state.window_titles'].sort(),
    );
    expect(lintState({ minutes: 31, historically_true_this_often: 0.7, window_titles: ['a'], heard_aloud: 'z'.repeat(600) })).toEqual([]);
  });
});
