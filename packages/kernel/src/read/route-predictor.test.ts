import { describe, expect, it } from 'vitest';
import { scoreRoutePredictor } from './route-predictor.js';

describe('the route predictor, scored (W5 step 8)', () => {
  it('a predictor that says each source\'s base rate has skill 0; one that is sure and right has skill 1', () => {
    const actuals = [{ turnId: 't1', tools: ['gnomon_signals'] }, { turnId: 't2', tools: [] }];
    const flat = scoreRoutePredictor([{ turnId: 't1', predicted: { gnomon_signals: 0.5 } }, { turnId: 't2', predicted: { gnomon_signals: 0.5 } }], actuals);
    expect(flat).toMatchObject({ n: 2, pairs: 2, skill: 0 });
    const sure = scoreRoutePredictor([{ turnId: 't1', predicted: { gnomon_signals: 1 } }, { turnId: 't2', predicted: { gnomon_signals: 0 } }], actuals);
    expect(sure).toMatchObject({ skill: 1, safe: 1 });
    // Sure and wrong: worse than the base rate, and the turn that used the source was not routed to it.
    expect(scoreRoutePredictor([{ turnId: 't1', predicted: { gnomon_signals: 0 } }, { turnId: 't2', predicted: { gnomon_signals: 1 } }], actuals)).toMatchObject({ skill: -3, safe: 0.5 });
  });

  it('only joined turns count, and a null answer is no pair', () => {
    expect(scoreRoutePredictor([{ turnId: 'x', predicted: { a: 0.3 } }], [])).toMatchObject({ n: 0, brier: null, skill: null, safe: null });
    expect(scoreRoutePredictor([{ turnId: 't', predicted: { a: null, b: 0.2 } }], [{ turnId: 't', tools: ['b'] }])).toMatchObject({ pairs: 1 });
  });
});
